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
 *   DOMAIN_PACKS         — Comma-separated or JSON array of pack names to load
 *   OIDC_ISSUER          — OIDC provider issuer URL (matches Helm configmap)
 *   OIDC_CLIENT_ID       — OIDC client ID
 *   OIDC_JWKS_URI        — JWKS endpoint override for non-Keycloak issuers
 *   OPENFGA_URL          — OpenFGA API URL (matches Helm configmap / docker-compose)
 *   OPENFGA_STORE_ID     — OpenFGA store ID
 *   POSTGRES_URL         — PostgreSQL connection string (with ?sslmode= for TLS)
 *   CEL_EVALUATOR_URL    — CEL gRPC sidecar address (default: localhost:50051)
 *   CORS_ALLOWED_ORIGINS — Comma-separated allowed origins (empty = deny all in prod)
 *   FHIR_BASE_URL        — Externally routable FHIR base URL for Bundle links
 *   REDPANDA_BROKERS     — Comma-separated Kafka/Redpanda brokers (enables persistent events)
 *   REDIS_URL            — Redis connection URL (enables distributed rate limiting)
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { GraphQLError } from 'graphql';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import { PostgresStorageProvider, PostgresAuditStore, PostgresConsentStore } from '@openfoundry/storage-postgres';
import {
  ObjectManager,
  LinkManager,
  EngineEventEmitter,
  InMemoryObjectSetStore,
  ObjectSetManager,
} from '@openfoundry/engine';
import { ActionExecutor, CelClient, SideEffectExecutor } from '@openfoundry/actions';
import type { SecurityLayer, CelEvaluator, ActionEventPublisher, EventBus as SideEffectEventBus, HttpClient as SideEffectHttpClient } from '@openfoundry/actions';
import { AuthorizationService, OidcAuthenticator, AuditWriter, MemoryAuditStore, ConsentService, MemoryConsentStore } from '@openfoundry/security';
import type { OpenFgaClientInterface } from '@openfoundry/security';
import type { StorageProvider, RequestContext } from '@openfoundry/spi';
import { createGraphQLServer, buildResolverContext } from './graphql/index.js';
import { generateRestRoutes } from './rest/index.js';
import { createFhirRouter } from './fhir/index.js';
import { InMemorySubscribableEventBus, SubscriptionManager } from './subscriptions/index.js';
import type { SubscribableEventBus } from './subscriptions/index.js';
import { RedpandaEventBus } from './events/index.js';
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
import { SlidingWindowRateLimiter, RedisRateLimiter } from './governance/index.js';
import type { RateLimiter, RateLimitIdentity } from './governance/index.js';
import { toSnakeCase } from './utils.js';
import { metricsMiddleware, metricsEndpoint, startStorageHealthGauge } from './metrics.js';
import { logger } from './logger.js';

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

  // ── OpenTelemetry ──
  // Must be initialized before significant work starts so the global
  // TracerProvider is registered for all getTracer()/withSpan() calls.
  const { initTelemetry } = await import('@openfoundry/observability');
  initTelemetry('openfoundry-api');

  // ── Validate production environment ──
  if (!isDev) {
    const missing = REQUIRED_PROD_VARS.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      logger.error(`FATAL: Production mode requires env vars: ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  // ── Rate Limiter ──
  // REDIS_URL → distributed rate limiting across pods; otherwise in-memory per-pod.
  let rateLimiter: RateLimiter;
  let redisClient: import('ioredis').Redis | undefined;
  const redisUrl = process.env['REDIS_URL'];
  if (redisUrl) {
    // Dynamic import for optional dependency — cast needed for CJS/ESM interop
    const ioredis = await import('ioredis');
    const RedisClient = ioredis.default as unknown as new (url: string, opts: Record<string, unknown>) => import('ioredis').Redis;
    redisClient = new RedisClient(redisUrl, {
      // Fail fast: rate limiting is QoS, not a security boundary.
      // Default ioredis retries 20 times with offline queue, stalling requests for seconds.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3_000,
      commandTimeout: 1_000,
    });
    rateLimiter = new RedisRateLimiter(redisClient);
    logger.info(`Rate limiter: Redis @ ${redisUrl.replace(/\/\/.*@/, '//<redacted>@')}`);
  } else {
    rateLimiter = new SlidingWindowRateLimiter();
    if (!isDev) {
      logger.warn('WARNING: Rate limiter is in-memory — limits are per-pod. Set REDIS_URL for distributed rate limiting.');
    }
  }

  // ── Storage ──
  let storage: StorageProvider;
  if (!isDev && process.env['POSTGRES_URL']) {
    const config = parsePostgresUrl(process.env['POSTGRES_URL']);
    storage = new PostgresStorageProvider(config);
    logger.info(`Storage: PostgreSQL @ ${config.host}:${config.port}/${config.database}`);
  } else {
    storage = new MemoryStorageProvider();
    if (isDev) {
      logger.warn('Storage: in-memory (development mode)');
    }
  }

  // ── Schema (load from domain packs) ──
  // DOMAIN_PACKS may be comma-separated names ("nhs-acute,aml") or JSON from Helm
  // ([{"name":"nhs-acute","version":"0.2.0"}]). Handle both formats.
  const packNames = parseDomainPacksEnv(process.env['DOMAIN_PACKS']);
  const { parsed: schema, spiSchema, packs, manifestRegistry, fieldPermissions } = await loadDomainPacks(undefined, packNames);
  logger.info(
    `Schema: loaded ${packs.length} domain pack(s) — ` +
    `${schema.objectTypes.length} object types, ` +
    `${schema.linkTypes.length} link types, ` +
    `${schema.enums.length} enums`,
  );
  if (schema.objectTypes.length === 0) {
    logger.warn('WARNING: No object types loaded — check DOMAIN_PACKS configuration.');
  }

  // Apply schema to storage (creates tables/indexes in Postgres, registers types in memory)
  const bootCtx: RequestContext = { tenantId: 'system', actorId: 'boot' };
  await storage.applySchema(bootCtx, spiSchema);

  // ── Engine ──
  // REDPANDA_BROKERS → persistent event streaming via Kafka protocol;
  // otherwise in-memory (events lost on restart).
  let eventBus: SubscribableEventBus;
  const redpandaBrokers = process.env['REDPANDA_BROKERS'];
  if (redpandaBrokers) {
    const rpBus = new RedpandaEventBus({
      brokers: redpandaBrokers.split(',').map(s => s.trim()),
    });
    await rpBus.connect();
    eventBus = rpBus;
    logger.info(`EventBus: Redpanda/Kafka @ ${redpandaBrokers}`);
  } else {
    eventBus = new InMemorySubscribableEventBus();
    if (!isDev) {
      logger.warn('WARNING: EventBus is in-memory — events will not survive restarts. Set REDPANDA_BROKERS to enable persistent streaming.');
    }
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
    logger.info(`Authorization: OpenFGA @ ${process.env['OPENFGA_URL']}`);
  } else {
    // Dev stub: allow everything
    fgaClient = {
      check: async () => ({ allowed: true }),
      listObjects: async () => ({ objects: [] }),
      writeTuples: async () => ({}),
      deleteTuples: async () => ({}),
    };
    if (isDev) {
      logger.warn('Authorization: allow-all stub (development mode)');
    }
  }
  const authorizationService = new AuthorizationService(fgaClient, fieldPermissions);

  // ── CEL Evaluator ──
  let cel: CelEvaluator;
  const celAddress = (process.env['CEL_EVALUATOR_URL'] ?? 'localhost:50051')
    .replace(/^grpc:\/\//, '');
  if (!isDev) {
    cel = new CelClient({ address: celAddress });
    logger.info(`CEL evaluator: gRPC @ ${celAddress}`);
  } else {
    // Dev stub: always evaluate to true
    cel = { async evaluate() { return { value: true }; } };
    logger.warn('CEL evaluator: allow-all stub (development mode)');
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
    logger.info('Audit: PostgreSQL (persistent)');
  } else {
    logger.warn('Audit: in-memory (development mode)');
  }

  // ── Consent Service (Section 7.3) ──
  // PostgresConsentStore accepts a constructor-level default tenantId but all
  // methods also accept per-call tenantId, threaded from RequestContext by each
  // API layer (GraphQL, REST, FHIR, Actions).
  const consentStore = (storage instanceof PostgresStorageProvider)
    ? new PostgresConsentStore(storage.pool)
    : new MemoryConsentStore();
  const consentService = new ConsentService(consentStore, authorizationService, {
    directCareExemptionEnabled: true,
  });
  if (storage instanceof PostgresStorageProvider) {
    logger.info('Consent: PostgreSQL (persistent)');
  } else {
    logger.warn('Consent: in-memory (development mode)');
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
  // ── Side-effect handler (webhooks + CloudEvents after action commit) ──
  const sideEffectHttpClient: SideEffectHttpClient = {
    async post(url, body, options) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 10_000);
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...options?.headers },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        return { status: resp.status };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
  const sideEffectBus: SideEffectEventBus = {
    async emit(event) {
      await eventBus.publish(event as unknown as import('@openfoundry/spi').CloudEvent);
    },
  };
  const sideEffectHandler = new SideEffectExecutor({
    httpClient: sideEffectHttpClient,
    eventBus: sideEffectBus,
  });

  const actionExecutor = new ActionExecutor({
    storage, security, cel, auditWriter,
    eventPublisher: actionEventPublisher,
    consentManager: consentService,
    sideEffectHandler,
  });

  // ── Object Sets ──
  const objectSetStore = new InMemoryObjectSetStore();
  const objectSetManager = new ObjectSetManager(objectSetStore, objectManager);

  // ── API Dependencies ──
  const deps: ApiDependencies = {
    schema,
    objectManager,
    linkManager,
    actionExecutor,
    authorizationService,
    authenticator,
    consentService,
    storage,
    manifestRegistry,
    objectSetManager,
  };

  // ── Express + HTTP Server ──
  const app = express();

  // Trust proxy headers (X-Forwarded-For) when behind ingress/load balancer.
  // Required for req.ip to reflect the real client IP, not the proxy IP.
  // In production, Kubernetes ingress terminates TLS and forwards traffic.
  if (!isDev) {
    app.set('trust proxy', 1); // trust first hop (ingress controller)
  }

  const httpServer = http.createServer(app);

  // ── GraphQL (Apollo Server + WebSocket Subscriptions) ──
  // Single executable schema shared by both Apollo (HTTP) and graphql-ws (WS)
  // transports. This guarantees mutations and subscriptions use the same PubSub.
  const { server: apolloServer, pubsub, executableSchema } = createGraphQLServer({ schema, deps, isDev });

  // WebSocket server for GraphQL subscriptions (graphql-ws protocol)
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: '/graphql',
    maxPayload: 64 * 1024, // 64 KB — GraphQL subscription payloads are small
  });
  const subscriptionManager = new SubscriptionManager({
    pubsub,
    eventBus,
    authenticate: async (connectionParams) => {
      const token = connectionParams?.['Authorization'] ?? connectionParams?.['authorization'];
      if (!token || typeof token !== 'string') {
        return { authenticated: false, error: 'Missing Authorization in connection params' };
      }
      try {
        const user = await extractUser(
          { headers: { authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` } } as import('express').Request,
          authenticator,
          isDev,
        );
        return { authenticated: true, user };
      } catch {
        return { authenticated: false, error: 'Invalid token' };
      }
    },
  });

  // Per-connection subscription tracking — prevents subscription-flood DoS.
  const MAX_SUBSCRIPTIONS_PER_CONNECTION = 50;
  const subscriptionCounts = new WeakMap<object, number>();

  const wsCleanup = useServer(
    {
      schema: executableSchema,
      context: async (ctx) => {
        const params = (ctx.connectionParams ?? {}) as Record<string, unknown>;
        const authResult = await subscriptionManager.authenticateConnection(params);
        if (!authResult.authenticated) {
          throw new Error(authResult.error);
        }
        return buildResolverContext(authResult.user, deps);
      },
      onSubscribe: (ctx) => {
        const key = (ctx as { extra?: object }).extra ?? ctx;
        const count = subscriptionCounts.get(key) ?? 0;
        if (count >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
          return [new GraphQLError('Subscription limit exceeded', {
            extensions: { code: 'RATE_LIMITED' },
          })];
        }
        subscriptionCounts.set(key, count + 1);
        return undefined; // proceed normally
      },
      onComplete: (ctx) => {
        const key = (ctx as { extra?: object }).extra ?? ctx;
        const count = subscriptionCounts.get(key) ?? 1;
        subscriptionCounts.set(key, Math.max(0, count - 1));
      },
    },
    wsServer as never,
  );

  subscriptionManager.start();

  apolloServer.addPlugin(ApolloServerPluginDrainHttpServer({ httpServer }) as never);
  apolloServer.addPlugin({
    async serverWillStart() {
      return {
        async drainServer() {
          subscriptionManager.stop();
          await wsCleanup.dispose();
        },
      };
    },
  });
  await apolloServer.start();

  // Security headers (disable CSP for GraphQL playground in dev)
  app.use(helmet({ contentSecurityPolicy: isDev ? false : undefined }));

  // CORS: restrict origins in production (fail-closed), allow-all in dev
  const corsOrigins = process.env['CORS_ALLOWED_ORIGINS']?.split(',').map(s => s.trim()).filter(Boolean);
  if (!isDev && (!corsOrigins || corsOrigins.length === 0)) {
    // Production: deny all cross-origin requests when not configured
    logger.warn('WARNING: CORS_ALLOWED_ORIGINS not set — all cross-origin requests will be denied. Set CORS_ALLOWED_ORIGINS if a frontend needs API access.');
    app.use(cors({ origin: false }));
  } else if (!isDev) {
    app.use(cors({ origin: corsOrigins, credentials: true }));
  } else {
    app.use(cors());
  }

  app.use(express.json({ limit: '1mb' }));

  // Pre-auth IP-based rate limiter: protects against unauthenticated floods
  // (auth+JWKS work is expensive; this gate runs before identity extraction)
  // Only per-IP (principal) limiting — no global tenant cap for unauthenticated traffic.
  // Explicit undefined suppresses defaults from shallow merge in both limiter constructors.
  const ipLimiterConfig = { tenant: undefined, principal: { windowMs: 60_000, maxRequests: 300 }, clientApp: undefined };
  const ipRateLimiter: RateLimiter = redisClient
    ? new RedisRateLimiter(redisClient, { config: ipLimiterConfig, keyPrefix: 'rl:ip:' })
    : new SlidingWindowRateLimiter(ipLimiterConfig);
  app.use(async (req, res, next) => {
    try {
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      const result = await ipRateLimiter.check({ tenantId: 'global', principalId: ip });
      if (!result.allowed) {
        res.setHeader('Retry-After', String(Math.ceil((result.resetAt - Date.now()) / 1000)));
        res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true } });
        return;
      }
    } catch (err) {
      // Fail open: rate limiter error should not block requests
      logger.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'IP rate limiter error, failing open');
    }
    next();
  });

  // ── Prometheus metrics ──
  app.use(metricsMiddleware);
  // Block external access to /metrics — Prometheus ServiceMonitor scrapes pod
  // directly (bypassing ingress). Requests through ingress carry X-Forwarded-For.
  app.get('/metrics', (req, res, next) => {
    if (!isDev && req.headers['x-forwarded-for']) {
      res.status(404).end();
      return;
    }
    next();
  }, metricsEndpoint);
  const stopHealthGauge = startStorageHealthGauge(storage);

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
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'Health check failed');
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
          const rlResult = await rateLimiter.check({ tenantId: user.tenantId, principalId: user.id } as RateLimitIdentity);
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
        const rlResult = await rateLimiter.check({ tenantId: user.tenantId, principalId: user.id } as RateLimitIdentity);
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
        logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'REST handler error');
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
  if (!isDev && !process.env['FHIR_BASE_URL']) {
    logger.warn('WARNING: FHIR_BASE_URL not set — Bundle fullUrl links will use http://localhost. Set FHIR_BASE_URL to the externally routable address.');
  }
  const fhirHandler = createFhirRouter({ deps, baseUrl: fhirBaseUrl });
  app.all('/fhir/*', async (req, res) => {
    try {
      authorizationService.clearFieldCache();
      const user = await extractUser(req, authenticator, isDev);

      // Rate limit check
      const rlResult = await rateLimiter.check({ tenantId: user.tenantId, principalId: user.id } as RateLimitIdentity);
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
      logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'FHIR handler error');
      res.status(500).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'fatal', code: 'exception', diagnostics: 'Internal server error' }] });
    }
  });

  // ── Graceful shutdown ──
  const SHUTDOWN_TIMEOUT_MS = 5_000;

  async function shutdown() {
    logger.info('Shutting down...');
    stopHealthGauge();
    subscriptionManager.stop();
    await apolloServer.stop();
    if (cel instanceof CelClient) {
      cel.close();
    }
    // Disconnect persistent event bus (Redpanda/Kafka) with timeout
    if (eventBus instanceof RedpandaEventBus) {
      try {
        await Promise.race([
          eventBus.disconnect(),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), SHUTDOWN_TIMEOUT_MS)),
        ]);
        logger.info('EventBus: disconnected');
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'EventBus disconnect error');
      }
    }
    // Close Redis connection (distributed rate limiting) with timeout
    if (redisClient) {
      try {
        await Promise.race([
          redisClient.quit(),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), SHUTDOWN_TIMEOUT_MS)),
        ]);
        logger.info('Redis: disconnected');
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'Redis disconnect error');
      }
    }
    if (storage instanceof PostgresStorageProvider) {
      await storage.close();
    }
    // Flush pending OTEL spans before exit
    const { shutdownTelemetry } = await import('@openfoundry/observability');
    await shutdownTelemetry();
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
  logger.info(`Open Foundry API gateway [${mode}] listening at http://localhost:${PORT}`);
  logger.info(`  GraphQL:  http://localhost:${PORT}/graphql`);
  logger.info(`  WS Subs:  ws://localhost:${PORT}/graphql`);
  logger.info(`  REST:     http://localhost:${PORT}/api/v1/`);
  logger.info(`  FHIR:     http://localhost:${PORT}/fhir/`);
  logger.info(`  Metrics:  http://localhost:${PORT}/metrics`);
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
      objectType: toSnakeCase(objectParam.type.name),
      objectIdParam: objectParam.name,
    });
  }

  return mappings;
}

// Fatal error handlers — log and exit rather than silently dying.
// Must be registered before main() so they catch errors during startup too.
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
  process.exit(1);
});

main().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
