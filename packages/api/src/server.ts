/**
 * Server entrypoint — starts the Open Foundry API gateway.
 *
 * Wires up all dependencies and starts listening on the configured port.
 * Used by the Dockerfile CMD and for local development.
 *
 * Configuration via environment variables:
 *   PORT                 — HTTP port (default: 4000)
 *   OIDC_ISSUER_URL      — OIDC provider issuer URL
 *   OIDC_CLIENT_ID       — OIDC client ID
 *   OPENFGA_API_URL      — OpenFGA API URL
 *   OPENFGA_STORE_ID     — OpenFGA store ID
 *   DATABASE_URL         — PostgreSQL connection string (optional; uses memory storage if absent)
 */

import { startStandaloneServer } from '@apollo/server/standalone';
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
import type { ApiDependencies } from './graphql/types.js';

const PORT = parseInt(process.env['PORT'] ?? '4000', 10);

async function main(): Promise<void> {
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
    issuer: process.env['OIDC_ISSUER_URL'] ?? 'http://localhost:8180/realms/openfoundry',
    clientId: process.env['OIDC_CLIENT_ID'] ?? 'openfoundry',
    jwksUri: `${process.env['OIDC_ISSUER_URL'] ?? 'http://localhost:8180/realms/openfoundry'}/protocol/openid-connect/certs`,
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

  const { server } = createGraphQLServer({ schema, deps });

  const { url } = await startStandaloneServer(server, {
    listen: { port: PORT },
    context: async () => {
      // In production, authenticate via OIDC token from request headers.
      // For development without Keycloak, use a default context.
      const user = {
        id: 'dev-user',
        name: 'Development User',
        email: 'dev@openfoundry.local',
        roles: ['admin'],
        groups: [],
        tenantId: 'default',
      };
      return buildResolverContext(user, deps);
    },
  });

  console.log(`Open Foundry API gateway listening at ${url}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
