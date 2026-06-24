/**
 * Security middleware setup for the API gateway.
 *
 * Applies Helmet (CSP + security headers), CORS, and IP-based rate limiting.
 * Extracted from server.ts to keep it under the target line count.
 */
import type { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import type { RateLimiter } from '../governance/index.js';
import type { Logger } from 'pino';

export interface SecurityMiddlewareOptions {
  isDev: boolean;
  logger: Logger;
  ipRateLimiter: RateLimiter;
}

export function applySecurityMiddleware(app: Express, opts: SecurityMiddlewareOptions): void {
  // Security headers (disable CSP for GraphQL playground in dev)
  app.use(helmet({ contentSecurityPolicy: opts.isDev ? false : undefined }));

  // CORS: restrict origins in production (fail-closed), allow-all in dev
  const corsOrigins = process.env['CORS_ALLOWED_ORIGINS']
    ?.split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!opts.isDev && (!corsOrigins || corsOrigins.length === 0)) {
    opts.logger.warn(
      'WARNING: CORS_ALLOWED_ORIGINS not set — all cross-origin requests will be denied. ' +
      'Set CORS_ALLOWED_ORIGINS if a frontend needs API access.',
    );
    app.use(cors({ origin: false }));
  } else if (!opts.isDev) {
    app.use(cors({ origin: corsOrigins, credentials: true }));
  } else {
    app.use(cors());
  }

  // Pre-auth IP-based rate limiter: protects against unauthenticated floods
  app.use(async (req, res, next) => {
    try {
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      const result = await opts.ipRateLimiter.check({ tenantId: 'global', principalId: ip });
      if (!result.allowed) {
        res.setHeader('Retry-After', String(Math.ceil((result.resetAt - Date.now()) / 1000)));
        res.status(429).json({
          error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true },
        });
        return;
      }
    } catch (err) {
      opts.logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        'IP rate limiter error, failing open',
      );
    }
    next();
  });
}
