/**
 * Server entrypoint — starts the Open Foundry API gateway.
 *
 * Mounts GraphQL, REST, and FHIR endpoints on a single Express server.
 * Used by the Dockerfile CMD and for local development.
 *
 * Configuration via environment variables:
 *   PORT                 — HTTP port (default: 4000)
 *   OIDC_ISSUER          — OIDC provider issuer URL (matches Helm configmap)
 *   OIDC_CLIENT_ID       — OIDC client ID
 *   OPENFGA_URL          — OpenFGA API URL (matches Helm configmap / docker-compose)
 *   OPENFGA_STORE_ID     — OpenFGA store ID
 *   POSTGRES_URL         — PostgreSQL connection string (optional; uses memory storage if absent)
 */

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import {
  ObjectManager,
  LinkManager,
  InMemoryEventBus,
  EngineEventEmitter,
} from '@openfoundry/engine';
import { ActionExecutor } from '@openfoundry/actions';
import type { SecurityLayer, CelEvaluator } from '@openfoundry/actions';
import { AuthorizationService, OidcAuthenticator } from '@openfoundry/security';
import type { ParsedSchema } from '@openfoundry/odl';
import { createGraphQLServer, buildResolverContext } from './graphql/index.js';
import { generateRestRoutes } from './rest/index.js';
import { createFhirRouter } from './fhir/index.js';
import type { ApiDependencies, ResolverContext } from './graphql/types.js';
import type { RestRequest } from './rest/types.js';

const PORT = parseInt(process.env['PORT'] ?? '4000', 10);

/** Build a default dev user context (bypasses OIDC in development). */
function devUser() {
  return {
    id: 'dev-user',
    name: 'Development User',
    email: 'dev@openfoundry.local',
    roles: ['admin'],
    groups: [],
    tenantId: 'default',
  };
}

async function main(): Promise<void> {
  // ── Dev-mode guard ──
  // This entrypoint uses allow-all stubs for auth, FGA, and CEL.
  // In production, these MUST be replaced with real service clients.
  const isDev = process.env['NODE_ENV'] !== 'production';
  if (isDev) {
    console.warn('⚠ Running in DEVELOPMENT mode — auth/authz/CEL are stubbed (allow-all)');
    console.warn('⚠ Set NODE_ENV=production and configure OIDC/FGA/CEL for deployment');
  }
  if (!isDev) {
    const missing = ['OIDC_ISSUER', 'OPENFGA_URL', 'OPENFGA_STORE_ID']
      .filter((k) => !process.env[k]);
    if (missing.length > 0) {
      console.error(`FATAL: Production mode requires env vars: ${missing.join(', ')}`);
      process.exit(1);
    }
    // TODO: Production mode still uses dev stubs (allow-all FGA, allow-all
    // security/CEL, in-memory storage, devUser identity). Replace with real
    // service clients wired from env vars before deploying to production.
    console.warn('⚠ WARNING: Production wiring not yet implemented — auth/FGA/CEL stubs still active');
  }

  // Schema must be loaded from domain packs at startup.
  // TODO: Load ParsedSchema from domain pack registry once SchemaRegistry is implemented.
  const schema: ParsedSchema = {
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    enums: [],
    interfaces: [],
    scalars: [],
  };

  // Storage — default to in-memory for development
  const storage = new MemoryStorageProvider();

  // Engine event bus
  const eventBus = new InMemoryEventBus();
  const emitter = new EngineEventEmitter(eventBus);

  const objectManager = new ObjectManager({ storage, schema, eventEmitter: emitter });
  const linkManager = new LinkManager({ storage, schema, eventEmitter: emitter });

  // Authorization — stub FGA client for development (allows all)
  const authorizationService = new AuthorizationService(
    {
      check: async () => ({ allowed: true }),
      listObjects: async () => ({ objects: [] }),
      writeTuples: async () => ({}),
      deleteTuples: async () => ({}),
    },
    [],
  );

  // Authentication
  const authenticator = new OidcAuthenticator();
  authenticator.configure({
    issuer: process.env['OIDC_ISSUER'] ?? 'http://localhost:8180/realms/openfoundry',
    clientId: process.env['OIDC_CLIENT_ID'] ?? 'openfoundry',
    jwksUri: `${process.env['OIDC_ISSUER'] ?? 'http://localhost:8180/realms/openfoundry'}/protocol/openid-connect/certs`,
  });

  // Action executor — stub security and CEL for development
  const security: SecurityLayer = {
    async checkPermission() { return { allowed: true }; },
  };
  const cel: CelEvaluator = {
    async evaluate() { return { value: true }; },
  };
  const actionExecutor = new ActionExecutor({ storage, security, cel });

  const deps: ApiDependencies = {
    schema,
    objectManager,
    linkManager,
    actionExecutor,
    authorizationService,
    authenticator,
    storage,
  };

  // Express + HTTP server
  const app = express();
  const httpServer = http.createServer(app);

  // GraphQL — Apollo Server with drain plugin for graceful shutdown
  const { server: apolloServer } = createGraphQLServer({ schema, deps });
  apolloServer.addPlugin(ApolloServerPluginDrainHttpServer({ httpServer }) as never);
  await apolloServer.start();

  app.use(cors());
  app.use(express.json());

  // Health check endpoints — used by Docker/Helm probes
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'api-gateway' });
  });
  app.get('/.well-known/apollo/server-health', (_req, res) => {
    res.json({ status: 'pass' });
  });

  // Mount GraphQL at /graphql
  app.use(
    '/graphql',
    expressMiddleware(apolloServer, {
      context: async (): Promise<ResolverContext> => {
        return buildResolverContext(devUser(), deps);
      },
    }),
  );

  // Mount REST routes at /api/v1/*
  const restRoutes = generateRestRoutes(schema, deps);
  for (const route of restRoutes) {
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
    app[method](route.pattern, async (req, res) => {
      try {
        const restReq: RestRequest = {
          method: req.method,
          path: req.path,
          params: req.params as Record<string, string>,
          query: req.query as Record<string, string>,
          body: req.body as Record<string, unknown>,
          user: devUser(),
        };
        const ctx: ResolverContext = buildResolverContext(devUser(), deps);
        const result = await route.handler(restReq, ctx);
        res.status(result.status).json(result.body);
      } catch (err) {
        console.error('REST handler error:', err);
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
      }
    });
  }

  // Mount FHIR routes at /fhir/*
  const fhirHandler = createFhirRouter({ deps, baseUrl: `http://localhost:${PORT}/fhir` });
  app.all('/fhir/*', async (req, res) => {
    try {
      const fhirReq = {
        method: req.method,
        path: req.path.replace(/^\/fhir/, ''),
        query: req.query as Record<string, string>,
        user: devUser(),
      };
      const result = await fhirHandler(fhirReq);
      if (result.headers) {
        for (const [key, value] of Object.entries(result.headers)) {
          res.setHeader(key, value);
        }
      }
      res.status(result.status).json(result.body);
    } catch (err) {
      console.error('FHIR handler error:', err);
      res.status(500).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'fatal', code: 'exception', diagnostics: 'Internal server error' }] });
    }
  });

  // Start listening
  await new Promise<void>((resolve) => {
    httpServer.listen(PORT, resolve);
  });

  console.log(`Open Foundry API gateway listening at http://localhost:${PORT}`);
  console.log(`  GraphQL:  http://localhost:${PORT}/graphql`);
  console.log(`  REST:     http://localhost:${PORT}/api/v1/`);
  console.log(`  FHIR:     http://localhost:${PORT}/fhir/`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
