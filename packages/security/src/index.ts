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
