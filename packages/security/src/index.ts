/**
 * @openfoundry/security
 *
 * OIDC authentication and authorization for the Open Foundry platform.
 * Supports NHS CIS2 token format with configurable role mapping.
 */

export type {
  AuthenticatedUser,
  OidcConfig,
  PlatformIdentity,
  RoleMappingConfig,
} from "./auth/index.js";
export { AuthenticationError } from "./auth/index.js";

export { OidcAuthenticator } from "./auth/index.js";

export { CIS2_ROLE_MAPPINGS, resolveRoles, resolveGroups } from "./auth/index.js";

// Audit trail (Section 7.2)
export type { AuditStore, AuditQueryFilter, AuditWriteInput } from "./audit/index.js";
export { AuditWriter, AuditQuery, MemoryAuditStore } from "./audit/index.js";
