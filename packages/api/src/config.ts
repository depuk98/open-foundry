/**
 * Production configuration helpers.
 *
 * Parses environment variables and instantiates real service clients
 * for production deployment. Dev mode uses in-memory stubs instead.
 */

import type { PostgresStorageConfig } from '@openfoundry/storage-postgres';
import type { OpenFgaClientInterface, AuthorizationService, OidcAuthenticator } from '@openfoundry/security';
import type { SecurityLayer } from '@openfoundry/actions';
import type { Request } from 'express';
import type { AuthenticatedUserInfo } from './graphql/types.js';

// ---------------------------------------------------------------------------
// Postgres URL parsing
// ---------------------------------------------------------------------------

export function parsePostgresUrl(url: string): PostgresStorageConfig {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || '5432', 10),
    database: u.pathname.replace(/^\//, ''),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

// ---------------------------------------------------------------------------
// OpenFGA client adapter
// ---------------------------------------------------------------------------

export function createFgaClient(apiUrl: string, storeId: string): OpenFgaClientInterface {
  // Lazy import to avoid pulling @openfga/sdk in dev mode
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OpenFgaClient } = require('@openfga/sdk') as typeof import('@openfga/sdk');
  const client = new OpenFgaClient({ apiUrl, storeId });
  return {
    check: (body) => client.check(body),
    listObjects: (body) => client.listObjects(body),
    writeTuples: (tuples) => client.writeTuples(tuples),
    deleteTuples: (tuples) => client.deleteTuples(tuples),
  };
}

// ---------------------------------------------------------------------------
// SecurityLayer bridge (authz -> action pipeline)
// ---------------------------------------------------------------------------

export function createSecurityLayer(authz: AuthorizationService): SecurityLayer {
  return {
    async checkPermission(actor, actionType, _params, _ctx) {
      const allowed = await authz.check(
        `user:${actor.id}`,
        'execute',
        `action:${actionType}`,
      );
      return { allowed };
    },
  };
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

export async function extractUser(
  req: Request,
  authenticator: OidcAuthenticator,
  isDev: boolean,
): Promise<AuthenticatedUserInfo> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    if (isDev) {
      return {
        id: 'dev-user',
        name: 'Development User',
        email: 'dev@openfoundry.local',
        roles: ['admin'],
        groups: [],
        tenantId: 'default',
      };
    }
    throw Object.assign(new Error('Authorization header required'), { status: 401 });
  }
  const token = authHeader.slice(7);
  return authenticator.authenticate(token);
}

// ---------------------------------------------------------------------------
// Required env vars for production
// ---------------------------------------------------------------------------

export const REQUIRED_PROD_VARS = [
  'OIDC_ISSUER',
  'OPENFGA_URL',
  'OPENFGA_STORE_ID',
  'POSTGRES_URL',
] as const;
