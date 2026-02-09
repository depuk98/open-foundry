import type { ObjectManager, LinkManager } from '@openfoundry/engine';
import type { ActionExecutor } from '@openfoundry/actions';
import type {
  AuthorizationService,
  OidcAuthenticator,
  ConsentService,
  AuditWriter,
} from '@openfoundry/security';
import type { ParsedSchema } from '@openfoundry/odl';
import type { RequestContext, StorageProvider, DataPurpose } from '@openfoundry/spi';

/**
 * Dependencies injected into the GraphQL API layer.
 */
export interface ApiDependencies {
  schema: ParsedSchema;
  objectManager: ObjectManager;
  linkManager: LinkManager;
  actionExecutor: ActionExecutor;
  authorizationService: AuthorizationService;
  authenticator: OidcAuthenticator;
  consentService?: ConsentService;
  auditWriter?: AuditWriter;
  storage: StorageProvider;
}

/**
 * Resolved context available in every GraphQL resolver.
 */
export interface ResolverContext {
  requestContext: RequestContext;
  user: AuthenticatedUserInfo;
  deps: ApiDependencies;
}

/**
 * Minimal authenticated user info passed through context.
 */
export interface AuthenticatedUserInfo {
  id: string;
  name: string;
  email: string;
  roles: string[];
  groups: string[];
  tenantId: string;
}

/**
 * Relay-style pagination arguments.
 */
export interface PaginationArgs {
  first?: number;
  after?: string;
  last?: number;
  before?: string;
}

/**
 * Relay-style connection result.
 */
export interface Connection<T> {
  edges: Edge<T>[];
  pageInfo: PageInfo;
  totalCount: number;
}

export interface Edge<T> {
  node: T;
  cursor: string;
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

/**
 * Consent purpose used for data access checks.
 */
export type ConsentPurpose = DataPurpose;

/**
 * Default consent purpose for GraphQL queries.
 */
export const DEFAULT_CONSENT_PURPOSE = 'DIRECT_CARE' as const;

/**
 * Default page size when first/last not specified.
 */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Maximum page size.
 */
export const MAX_PAGE_SIZE = 100;
