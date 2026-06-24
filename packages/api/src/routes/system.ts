/**
 * System routes: health checks, Prometheus metrics, admin endpoints.
 *
 * Extracted from server.ts — these are pure Express route registrations
 * that don't capture any server.ts closures.
 */
import type { Express, RequestHandler, Request, Response } from 'express';
import type { StorageProvider } from '@openfoundry/spi';
import type { Logger } from 'pino';

interface PackInfo {
  manifest: { name: string; version: string; namespace: string; description?: string; permissions?: string[] };
  external: boolean;
  typeCounts: { objectTypes: number; linkTypes: number; actionTypes: number };
}

interface SchemaInfo {
  objectTypes: unknown[];
  linkTypes: unknown[];
  actionTypes: unknown[];
}

export interface SystemRoutesOptions {
  isDev: boolean;
  logger: Logger;
  storage: StorageProvider;
  packInfos: PackInfo[];
  schema: SchemaInfo;
  connectorManifests: Array<{ packName: string }>;
  metricsMiddleware: RequestHandler;
  metricsEndpoint: RequestHandler;
  startStorageHealthGauge: (s: StorageProvider) => () => void;
  packLoaded: { set: (labels: Record<string, string>, value: number) => void };
}

export function registerSystemRoutes(app: Express, opts: SystemRoutesOptions): () => void {
  app.use(opts.metricsMiddleware);
  app.get('/metrics', (req: Request, res: Response, next) => {
    if (!opts.isDev && req.headers['x-forwarded-for']) {
      res.status(404).end();
      return;
    }
    next();
  }, opts.metricsEndpoint);

  const stopHealthGauge = opts.startStorageHealthGauge(opts.storage);

  // Health check — readiness probe
  app.get('/health', async (_req, res) => {
    try {
      const storageHealth = await opts.storage.healthCheck();
      const status = storageHealth.healthy ? 'ok' : 'degraded';
      const httpStatus = storageHealth.healthy ? 200 : 503;
      res.status(httpStatus).json({
        status,
        service: 'api-gateway',
        storage: { healthy: storageHealth.healthy },
      });
    } catch (err) {
      opts.logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'Health check failed');
      res.status(503).json({ status: 'unhealthy', service: 'api-gateway' });
    }
  });

  // Healthz — liveness probe (lightweight)
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'pass' });
  });
  app.get('/.well-known/apollo/server-health', (_req, res) => {
    res.json({ status: 'pass' });
  });

  // Admin endpoints
  for (const info of opts.packInfos) {
    opts.packLoaded.set(
      { name: info.manifest.name, version: info.manifest.version, origin: info.external ? 'external' : 'primary' },
      1,
    );
  }

  app.get('/admin/packs', (_req, res) => {
    res.json({
      packs: opts.packInfos.map(info => ({
        name: info.manifest.name,
        version: info.manifest.version,
        namespace: info.manifest.namespace,
        description: info.manifest.description ?? null,
        external: info.external,
        objectTypes: info.typeCounts.objectTypes,
        linkTypes: info.typeCounts.linkTypes,
        actionTypes: info.typeCounts.actionTypes,
        connectors: opts.connectorManifests.filter(c => c.packName === info.manifest.name).length,
        permissions: (info.manifest.permissions ?? []).filter(f => f.endsWith('.fga')).length,
      })),
      totals: {
        objectTypes: opts.schema.objectTypes.length,
        linkTypes: opts.schema.linkTypes.length,
        actionTypes: opts.schema.actionTypes.length,
        connectors: opts.connectorManifests.length,
      },
    });
  });

  return stopHealthGauge;
}
