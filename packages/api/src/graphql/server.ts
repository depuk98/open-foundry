/**
 * GraphQL API server.
 *
 * Creates an Apollo Server instance with auto-generated schema and resolvers
 * from the ODL ParsedSchema.
 */

import crypto from 'node:crypto';
import { ApolloServer } from '@apollo/server';
import { buildSchema } from 'graphql';
import { generateGraphQLSchema } from '@openfoundry/odl';
import type { ParsedSchema } from '@openfoundry/odl';
import type { ApiDependencies, ResolverContext, AuthenticatedUserInfo } from './types.js';
import { generateResolvers } from './resolver-generator.js';
import type { PubSub } from 'graphql-subscriptions';

export interface GraphQLServerConfig {
  schema: ParsedSchema;
  deps: ApiDependencies;
}

export interface GraphQLServerInstance {
  server: ApolloServer<ResolverContext>;
  pubsub: PubSub;
  sdl: string;
}

/**
 * Create the GraphQL server with auto-generated schema and resolvers.
 */
export function createGraphQLServer(config: GraphQLServerConfig): GraphQLServerInstance {
  // 1. Generate GraphQL SDL from ODL schema
  const sdl = generateGraphQLSchema(config.schema);

  // 2. Generate resolvers
  const { resolvers, pubsub } = generateResolvers(config.schema, config.deps);

  // 3. Build executable schema
  const typeDefs = buildSchema(sdl);

  // 4. Create Apollo Server
  const server = new ApolloServer<ResolverContext>({
    typeDefs,
    resolvers,
    includeStacktraceInErrorResponses: false,
  });

  return { server, pubsub, sdl };
}

/**
 * Build a ResolverContext from an authenticated user and dependencies.
 */
export function buildResolverContext(
  user: AuthenticatedUserInfo,
  deps: ApiDependencies,
): ResolverContext {
  return {
    requestContext: {
      tenantId: user.tenantId,
      actorId: user.id,
      traceId: crypto.randomUUID(),
    },
    user,
    deps,
  };
}
