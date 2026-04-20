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
import helmet from 'helmet';
import { GraphQLError } from 'graphql';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import { PostgresStorageProvider, PostgresAuditStore } from '@openfoundry/storage-postgres';
import {
  ObjectManager,
  LinkManager,
  InMemoryEventBus,
  EngineEventEmitter,
} from '@openfoundry/engine';
import { ActionExecutor, CelClient } from '@openfoundry/actions';
import type { SecurityLayer, CelEvaluator, ActionEventPublisher } from '@openfoundry/actions';
import { AuthorizationService, OidcAuthenticator, AuditWriter, MemoryAuditStore } from '@openfoundry/security';
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
import type { ActionAuthzMapping } from './config.js';
import { loadDomainPacks } from './schema-loader.js';
import { SlidingWindowRateLimiter } from './governance/index.js';
import type { RateLimitIdentity } from './governance/index.js';

const PORT = parseInt(process.env['PORT'] ?? '4000', 10);

/**
 * Parse DOMAIN_PACKS env var which may be:
 *   - Comma-separated names: "nhs-acute,aml"
 *   - JSON array of objects from Helm: [{"name":"nhs-acute","version":"0.2.0"}]
 *   - undefined (returns undefined → auto-discover)
 */
function parseDomainPacksEnv(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item: unknown) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object' && 'name' in item) return String((item as { name: unknown }).name);
            return '';
          })
          .filter(Boolean);
      }
    } catch {
      // Fall through to comma-split
    }
  }
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}

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

  // ── Rate Limiter ──
  const rateLimiter = new SlidingWindowRateLimiter();

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
  // DOMAIN_PACKS may be comma-separated names ("nhs-acute,aml") or JSON from Helm
  // ([{"name":"nhs-acute","version":"0.2.0"}]). Handle both formats.
  const packNames = parseDomainPacksEnv(process.env['DOMAIN_PACKS']);
  const { parsed: schema, spiSchema, packs, manifestRegistry, fieldPermissions } = await loadDomainPacks(undefined, packNames);
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
  if (!isDev) {
    console.warn('WARNING: EventBus is in-memory — events will not survive restarts. Set REDPANDA_BROKERS to enable persistent streaming.');
  }
  const emitter = new EngineEventEmitter(eventBus);
  const objectManager = new ObjectManager({ storage, schema, eventEmitter: emitter });
  const linkManager = new LinkManager({ storage, schema, eventEmitter: emitter });

  // ── Authentication ──
  const oidcIssuer = process.env['OIDC_ISSUER'] ?? 'http://localhost:8180/realms/openfoundry';
  const authenticator = new OidcAuthenticator();
  authenticator.configure({
    issuer: oidcIssuer,
    clientId: process.env['OIDC_CLIENT_ID'] ?? 'openfoundry',
    // OIDC_JWKS_URI overrides for non-Keycloak issuers (e.g. NHS CIS2).
    // Default: Keycloak-style path. Set OIDC_JWKS_URI for other providers.
    jwksUri: process.env['OIDC_JWKS_URI'] ?? `${oidcIssuer}/protocol/openid-connect/certs`,
  });

  // ── Authorization (OpenFGA) ──
  let fgaClient: OpenFgaClientInterface;
  if (!isDev && process.env['OPENFGA_URL'] && process.env['OPENFGA_STORE_ID']) {
    fgaClient = await createFgaClient(
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
  const authorizationService = new AuthorizationService(fgaClient, fieldPermissions);

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
  // Derive action-to-FGA mappings from schema actionTypes.
  // E.g., AdmitPatient → check can_admit on patient:<id>
  const actionMappings = deriveActionAuthzMappings(schema);
  let security: SecurityLayer;
  if (!isDev) {
    security = createSecurityLayer(authorizationService, actionMappings);
  } else {
    security = { async checkPermission() { return { allowed: true }; } };
  }

  // ── Audit Trail ──
  const auditStore = (storage instanceof PostgresStorageProvider)
    ? new PostgresAuditStore(storage.pool)
    : new MemoryAuditStore();
  const securityAuditWriter = new AuditWriter(auditStore);
  // Adapt return type: security AuditWriter returns AuditRecord, action pipeline expects void
  const auditWriter = { async write(record: Parameters<typeof securityAuditWriter.write>[0]) { await securityAuditWriter.write(record); } };
  if (storage instanceof PostgresStorageProvider) {
    console.log('Audit: PostgreSQL (persistent)');
  } else {
    console.warn('Audit: in-memory (development mode)');
  }

  // ── Action Executor ──
  // Bridge the engine event bus to the action event publisher interface
  const actionEventPublisher: ActionEventPublisher = {
    async publishObjectChange(changeType, objectType, objectId, _before, _after, cause, ctx) {
      const version = 1; // Actions don't track version; use placeholder
      const eventCause = { actionType: cause.actionType, actionId: cause.actionId, actor: cause.actor };
      if (changeType === 'created') await emitter.emitObjectCreated(ctx, objectType, objectId, version, eventCause);
      else if (changeType === 'updated') await emitter.emitObjectUpdated(ctx, objectType, objectId, version, {}, eventCause);
      else if (changeType === 'deleted') await emitter.emitObjectDeleted(ctx, objectType, objectId, version, eventCause);
    },
    async publishLinkChange(changeType, linkType, linkId, fromId, toId, cause, ctx) {
      const eventCause = { actionType: cause.actionType, actionId: cause.actionId, actor: cause.actor };
      if (changeType === 'created') await emitter.emitLinkCreated(ctx, linkType, linkId, fromId, toId, 1, eventCause);
      else if (changeType === 'deleted') await emitter.emitLinkDeleted(ctx, linkType, linkId, fromId, toId, 1, eventCause);
    },
  };
  const actionExecutor = new ActionExecutor({ storage, security, cel, auditWriter, eventPublisher: actionEventPublisher });

  // ── API Dependencies ──
  const deps: ApiDependencies = {
    schema,
    objectManager,
    linkManager,
    actionExecutor,
    authorizationService,
    authenticator,
    storage,
    manifestRegistry,
  };

  // ── Express + HTTP Server ──
  const app = express();
  const httpServer = http.createServer(app);

  // ── GraphQL (Apollo Server) ──
  const { server: apolloServer } = createGraphQLServer({ schema, deps });
  apolloServer.addPlugin(ApolloServerPluginDrainHttpServer({ httpServer }) as never);
  await apolloServer.start();

  // Security headers (disable CSP for GraphQL playground in dev)
  app.use(helmet({ contentSecurityPolicy: isDev ? false : undefined }));

  // CORS: restrict origins in production (fail-closed), allow-all in dev
  const corsOrigins = process.env['CORS_ALLOWED_ORIGINS']?.split(',').map(s => s.trim()).filter(Boolean);
  if (!isDev && (!corsOrigins || corsOrigins.length === 0)) {
    // Production: deny all cross-origin requests when not configured
    app.use(cors({ origin: false }));
  } else if (!isDev) {
    app.use(cors({ origin: corsOrigins, credentials: true }));
  } else {
    app.use(cors());
  }

  app.use(express.json({ limit: '1mb' }));

  // Pre-auth IP-based rate limiter: protects against unauthenticated floods
  // (auth+JWKS work is expensive; this gate runs before identity extraction)
  const ipRateLimiter = new SlidingWindowRateLimiter({
    principal: { windowMs: 60_000, maxRequests: 300 },
  });
  app.use((req, res, next) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const result = ipRateLimiter.check({ tenantId: 'global', principalId: ip });
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.ceil((result.resetAt - Date.now()) / 1000)));
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true } });
      return;
    }
    next();
  });

  // ── Health check ──
  // /health — used by readiness probe; returns 503 when storage is degraded
  app.get('/health', async (_req, res) => {
    try {
      const storageHealth = await storage.healthCheck();
      const status = storageHealth.healthy ? 'ok' : 'degraded';
      const httpStatus = storageHealth.healthy ? 200 : 503;
      res.status(httpStatus).json({
        status,
        service: 'api-gateway',
        storage: { healthy: storageHealth.healthy },
      });
    } catch {
      res.status(503).json({ status: 'unhealthy', service: 'api-gateway' });
    }
  });
  // /healthz — liveness probe (lightweight, always pass if process is up)
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'pass' });
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
        try {
          const user = await extractUser(req, authenticator, isDev);

          // Rate limit check
          const rlResult = rateLimiter.check({ tenantId: user.tenantId, principalId: user.id } as RateLimitIdentity);
          if (!rlResult.allowed) {
            throw new GraphQLError(`Rate limit exceeded (by ${rlResult.exceededBy})`, {
              extensions: {
                code: 'RATE_LIMITED',
                http: { status: 429 },
                retryAfter: Math.ceil((rlResult.resetAt - Date.now()) / 1000),
              },
            });
          }

          return buildResolverContext(user, deps);
        } catch (err) {
          // Map auth failures to proper GraphQL errors with 401 status
          if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) {
            throw new GraphQLError('Authentication required', {
              extensions: {
                code: 'UNAUTHENTICATED',
                http: { status: 401 },
              },
            });
          }
          throw err;
        }
      },
    }),
  );

  // ── REST at /api/v1/* ──
  const restRoutes = generateRestRoutes(schema, deps);
  for (const route of restRoutes) {
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
    app[method](route.pattern, async (req, res) => {
      try {
        authorizationService.clearFieldCache();
        const user = await extractUser(req, authenticator, isDev);

        // Rate limit check
        const rlResult = rateLimiter.check({ tenantId: user.tenantId, principalId: user.id } as RateLimitIdentity);
        if (!rlResult.allowed) {
          res.setHeader('Retry-After', String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)));
          res.status(429).json({ error: { code: 'RATE_LIMITED', message: `Rate limit exceeded (by ${rlResult.exceededBy})`, retryable: true } });
          return;
        }

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
          res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
          return;
        }
        console.error('REST handler error:', err instanceof Error ? err.message : 'unknown');
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
  const fhirBaseUrl = process.env['FHIR_BASE_URL'] ?? `http://localhost:${PORT}/fhir`;
  const fhirHandler = createFhirRouter({ deps, baseUrl: fhirBaseUrl });
  app.all('/fhir/*', async (req, res) => {
    try {
      authorizationService.clearFieldCache();
      const user = await extractUser(req, authenticator, isDev);

      // Rate limit check
      const rlResult = rateLimiter.check({ tenantId: user.tenantId, principalId: user.id } as RateLimitIdentity);
      if (!rlResult.allowed) {
        res.setHeader('Retry-After', String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)));
        res.status(429).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'throttled', diagnostics: 'Rate limit exceeded' }] });
        return;
      }

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
        res.status(401).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'login', diagnostics: 'Authentication required' }] });
        return;
      }
      console.error('FHIR handler error:', err instanceof Error ? err.message : 'unknown');
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

/** Convert PascalCase to snake_case — must match FGA codegen convention. */
function fgaSnakeCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Build action authorization mappings from the parsed schema's actionTypes.
 * Extracts verb from PascalCase name, finds first object-typed param.
 * Uses snake_case for FGA object types (matching OpenFGA codegen convention).
 */
function deriveActionAuthzMappings(
  schema: import('@openfoundry/odl').ParsedSchema,
): Map<string, ActionAuthzMapping> {
  const mappings = new Map<string, ActionAuthzMapping>();
  const objectTypeNames = new Set(schema.objectTypes.map(o => o.name));

  for (const action of schema.actionTypes) {
    // Extract verb: "AdmitPatient" → "admit", "DischargePatient" → "discharge", "TransferWard" → "transfer"
    const verbMatch = action.name.match(/^([A-Z][a-z]+)/);
    if (!verbMatch) continue;
    const verb = verbMatch[1]!.toLowerCase();
    const relation = `can_${verb}`;

    // Find first @param field that references an ObjectType (the authorization target)
    const paramFields = action.fields.filter(f =>
      f.directives.some(d => d.kind === 'param'),
    );
    const objectParam = paramFields.find(f => objectTypeNames.has(f.type.name));
    if (!objectParam) continue;

    mappings.set(action.name, {
      relation,
      objectType: fgaSnakeCase(objectParam.type.name),
      objectIdParam: objectParam.name,
    });
  }

  return mappings;
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
