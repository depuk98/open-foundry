/**
 * Server entrypoint — starts the Open Foundry API gateway.
 *
 * Mounts GraphQL, REST, and FHIR endpoints on a single Express server.
 * Used by the Dockerfile CMD and for local development.
 *
 * Configuration via environment variables:
 *   PORT                 — HTTP port (default: 4000)
 *   NODE_ENV             — 'production' enables real service wiring
 *   DOMAIN_PACKS_DIR     — Path to domain-packs directory (auto-detected if omitted)
 *   DOMAIN_PACKS         — Comma-separated pack names to load (default: all found)
 *   OIDC_ISSUER          — OIDC provider issuer URL (matches Helm configmap)
 *   OIDC_CLIENT_ID       — OIDC client ID
 *   OPENFGA_URL          — OpenFGA API URL (matches Helm configmap / docker-compose)
 *   OPENFGA_STORE_ID     — OpenFGA store ID
 *   POSTGRES_URL         — PostgreSQL connection string
 *   CEL_EVALUATOR_URL    — CEL gRPC sidecar address (default: localhost:50051)
 */

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import { PostgresStorageProvider } from '@openfoundry/storage-postgres';
import {
  ObjectManager,
  LinkManager,
  InMemoryEventBus,
  EngineEventEmitter,
} from '@openfoundry/engine';
import { ActionExecutor, CelClient } from '@openfoundry/actions';
import type { SecurityLayer, CelEvaluator } from '@openfoundry/actions';
import { AuthorizationService, OidcAuthenticator } from '@openfoundry/security';
import type { OpenFgaClientInterface } from '@openfoundry/security';
import type { StorageProvider, RequestContext } from '@openfoundry/spi';
import { createGraphQLServer, buildResolverContext } from './graphql/index.js';
import { generateRestRoutes } from './rest/index.js';
import { createFhirRouter } from './fhir/index.js';
import type { ApiDependencies, ResolverContext } from './graphql/types.js';
import type { RestRequest } from './rest/types.js';
import {
  parsePostgresUrl,
  createFgaClient,
  createSecurityLayer,
  extractUser,
  REQUIRED_PROD_VARS,
} from './config.js';
import { loadDomainPacks } from './schema-loader.js';

const PORT = parseInt(process.env['PORT'] ?? '4000', 10);

async function main(): Promise<void> {
  const isDev = process.env['NODE_ENV'] !== 'production';

  // ── Validate production environment ──
  if (!isDev) {
    const missing = REQUIRED_PROD_VARS.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      console.error(`FATAL: Production mode requires env vars: ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  // ── Storage ──
  let storage: StorageProvider;
  if (!isDev && process.env['POSTGRES_URL']) {
    const config = parsePostgresUrl(process.env['POSTGRES_URL']);
    storage = new PostgresStorageProvider(config);
    console.log(`Storage: PostgreSQL @ ${config.host}:${config.port}/${config.database}`);
  } else {
    storage = new MemoryStorageProvider();
    if (isDev) {
      console.warn('Storage: in-memory (development mode)');
    }
  }

  // ── Schema (load from domain packs) ──
  const packNames = process.env['DOMAIN_PACKS']?.split(',').map(s => s.trim()).filter(Boolean);
  const { parsed: schema, spiSchema, packs } = await loadDomainPacks(undefined, packNames);
  console.log(
    `Schema: loaded ${packs.length} domain pack(s) — ` +
    `${schema.objectTypes.length} object types, ` +
    `${schema.linkTypes.length} link types, ` +
    `${schema.enums.length} enums`,
  );

  // Apply schema to storage (creates tables/indexes in Postgres, registers types in memory)
  const bootCtx: RequestContext = { tenantId: 'system', actorId: 'boot' };
  await storage.applySchema(bootCtx, spiSchema);

  // ── Engine ──
  const eventBus = new InMemoryEventBus();
  const emitter = new EngineEventEmitter(eventBus);
  const objectManager = new ObjectManager({ storage, schema, eventEmitter: emitter });
  const linkManager = new LinkManager({ storage, schema, eventEmitter: emitter });

  // ── Authentication ──
  const authenticator = new OidcAuthenticator();
  authenticator.configure({
    issuer: process.env['OIDC_ISSUER'] ?? 'http://localhost:8180/realms/openfoundry',
    clientId: process.env['OIDC_CLIENT_ID'] ?? 'openfoundry',
    jwksUri: `${process.env['OIDC_ISSUER'] ?? 'http://localhost:8180/realms/openfoundry'}/protocol/openid-connect/certs`,
  });

  // ── Authorization (OpenFGA) ──
  let fgaClient: OpenFgaClientInterface;
  if (!isDev && process.env['OPENFGA_URL'] && process.env['OPENFGA_STORE_ID']) {
    fgaClient = createFgaClient(
      process.env['OPENFGA_URL'],
      process.env['OPENFGA_STORE_ID'],
    );
    console.log(`Authorization: OpenFGA @ ${process.env['OPENFGA_URL']}`);
  } else {
    // Dev stub: allow everything
    fgaClient = {
      check: async () => ({ allowed: true }),
      listObjects: async () => ({ objects: [] }),
      writeTuples: async () => ({}),
      deleteTuples: async () => ({}),
    };
    if (isDev) {
      console.warn('Authorization: allow-all stub (development mode)');
    }
  }
  const authorizationService = new AuthorizationService(fgaClient, []);

  // ── CEL Evaluator ──
  let cel: CelEvaluator;
  const celAddress = (process.env['CEL_EVALUATOR_URL'] ?? 'localhost:50051')
    .replace(/^grpc:\/\//, '');
  if (!isDev) {
    cel = new CelClient({ address: celAddress });
    console.log(`CEL evaluator: gRPC @ ${celAddress}`);
  } else {
    // Dev stub: always evaluate to true
    cel = { async evaluate() { return { value: true }; } };
    console.warn('CEL evaluator: allow-all stub (development mode)');
  }

  // ── Security Layer (for action pipeline) ──
  let security: SecurityLayer;
  if (!isDev) {
    security = createSecurityLayer(authorizationService);
  } else {
    security = { async checkPermission() { return { allowed: true }; } };
  }

  // ── Action Executor ──
  const actionExecutor = new ActionExecutor({ storage, security, cel });

  // ── API Dependencies ──
  const deps: ApiDependencies = {
    schema,
    objectManager,
    linkManager,
    actionExecutor,
    authorizationService,
    authenticator,
    storage,
  };

  // ── Express + HTTP Server ──
  const app = express();
  const httpServer = http.createServer(app);

  // ── GraphQL (Apollo Server) ──
  const { server: apolloServer } = createGraphQLServer({ schema, deps });
  apolloServer.addPlugin(ApolloServerPluginDrainHttpServer({ httpServer }) as never);
  await apolloServer.start();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // ── Health check ──
  app.get('/health', async (_req, res) => {
    try {
      const storageHealth = await storage.healthCheck();
      res.json({
        status: storageHealth.healthy ? 'ok' : 'degraded',
        service: 'api-gateway',
        storage: { healthy: storageHealth.healthy },
      });
    } catch {
      res.status(503).json({ status: 'unhealthy', service: 'api-gateway' });
    }
  });
  app.get('/.well-known/apollo/server-health', (_req, res) => {
    res.json({ status: 'pass' });
  });

  // ── GraphQL at /graphql ──
  app.use(
    '/graphql',
    expressMiddleware(apolloServer, {
      context: async ({ req }): Promise<ResolverContext> => {
        authorizationService.clearFieldCache();
        const user = await extractUser(req, authenticator, isDev);
        return buildResolverContext(user, deps);
      },
    }),
  );

  // ── REST at /api/v1/* ──
  const restRoutes = generateRestRoutes(schema, deps);
  for (const route of restRoutes) {
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
    app[method](route.pattern, async (req, res) => {
      try {
        const user = await extractUser(req, authenticator, isDev);
        const restReq: RestRequest = {
          method: req.method,
          path: req.path,
          params: req.params as Record<string, string>,
          query: req.query as Record<string, string>,
          body: req.body as Record<string, unknown>,
          user,
        };
        const ctx: ResolverContext = buildResolverContext(user, deps);
        const result = await route.handler(restReq, ctx);
        res.status(result.status).json(result.body);
      } catch (err) {
        if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) {
          res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Authorization required' } });
          return;
        }
        console.error('REST handler error:', err);
        res.status(500).json({
          error: {
            code: 'INTERNAL_ERROR',
            category: 'system',
            message: 'Internal server error',
            retryable: false,
            details: {},
            traceId: 'unknown',
            timestamp: new Date().toISOString(),
          },
        });
      }
    });
  }

  // ── FHIR at /fhir/* ──
  const fhirHandler = createFhirRouter({ deps, baseUrl: `http://localhost:${PORT}/fhir` });
  app.all('/fhir/*', async (req, res) => {
    try {
      const user = await extractUser(req, authenticator, isDev);
      const fhirReq = {
        method: req.method,
        path: req.path.replace(/^\/fhir/, ''),
        query: req.query as Record<string, string>,
        user,
      };
      const result = await fhirHandler(fhirReq);
      if (result.headers) {
        for (const [key, value] of Object.entries(result.headers)) {
          res.setHeader(key, value);
        }
      }
      res.status(result.status).json(result.body);
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) {
        res.status(401).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'login', diagnostics: 'Authorization required' }] });
        return;
      }
      console.error('FHIR handler error:', err);
      res.status(500).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'fatal', code: 'exception', diagnostics: 'Internal server error' }] });
    }
  });

  // ── Graceful shutdown ──
  async function shutdown() {
    console.log('Shutting down...');
    await apolloServer.stop();
    if (cel instanceof CelClient) {
      cel.close();
    }
    if (storage instanceof PostgresStorageProvider) {
      await storage.close();
    }
    httpServer.close();
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // ── Start ──
  await new Promise<void>((resolve) => {
    httpServer.listen(PORT, resolve);
  });

  const mode = isDev ? 'DEVELOPMENT' : 'PRODUCTION';
  console.log(`Open Foundry API gateway [${mode}] listening at http://localhost:${PORT}`);
  console.log(`  GraphQL:  http://localhost:${PORT}/graphql`);
  console.log(`  REST:     http://localhost:${PORT}/api/v1/`);
  console.log(`  FHIR:     http://localhost:${PORT}/fhir/`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
