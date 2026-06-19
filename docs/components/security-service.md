---
title: Security Service
created: 2026-06-18
last_updated: 2026-06-18
type: component
package: "@openfoundry/security"
status: active
related_components:
  - spi
  - odl
  - api-gateway
  - action-executor
  - observability-library
---

# Security Service

The `@openfoundry/security` package provides the **security and governance layer** for the Open Foundry platform. It implements four cross-cutting security concerns: OIDC-based authentication with CIS2 role mapping, ReBAC (Relationship-Based Access Control) via OpenFGA, immutable audit trail recording, and healthcare-aware consent management. Every API request flows through this layer; no data operation MAY bypass it.

## Public API

**Authentication (OIDC) — Section 7.4:**
- `OidcAuthenticator` — Validates OIDC access tokens (JWKS auto-rotation, 5s timeout, 30s cooldown on failure). Extracts `AuthenticatedUser` with principal ID, roles, groups, and tenant.
- `CIS2_ROLE_MAPPINGS` — Pre-configured NHS CIS2/Smartcard role mappings.
- `resolveRoles(token)`, `resolveGroups(token)` — Extracts and maps CIS2 roles and groups from token claims.
- `AuthenticationError` — Standardized authentication error class.
- Types: `AuthenticatedUser`, `OidcConfig`, `PlatformIdentity`, `RoleMappingConfig`.

**Authorization (ReBAC via OpenFGA) — Section 7.1:**
- `AuthorizationService` — Evaluates user permission to perform operations on objects using OpenFGA relationship tuples. Supports per-type and per-field permission checks.
- `AuthorizationError` — Standardized authorization error class.
- Types: `PermissionLevel`, `FieldPermissionRule`, `FieldPermissionConfig`, `RedactionResult`, `FieldCacheKey`, `OpenFgaClientInterface` (pluggable OpenFGA client).

**Audit Trail — Section 7.2:**
- `AuditWriter` — Writes immutable, append-only audit records for every mutation. Accepts `AuditWriteInput` and writes to a pluggable `AuditStore`.
- `AuditQuery` — Queries audit records with filtering, pagination, and time-range support.
- `MemoryAuditStore` — In-memory `AuditStore` implementation for development and testing.
- Types: `AuditStore`, `AuditQueryFilter`, `AuditWriteInput`.

**Consent Management — Section 7.3:**
- `ConsentService` — Manages multi-tenant consent records with healthcare direct-care exemptions. Evaluates consent decisions per-object-per-purpose. Supports field-level restrictions.
- `MemoryConsentStore` — In-memory `ConsentStore` implementation for development and testing.
- `ConsentError` — Standardized consent error class.
- Types: `ConsentManagerConfig`, `ConsentFilterResult`, `SingleObjectConsentResult`, `ConsentStore`.

**Field-Level Redaction:**
- `AuthorizationService` includes field-level redaction: after a query returns objects, the authorization layer strips fields marked `@sensitive` from responses when the viewer lacks read permission on those fields. Redacted fields are replaced with `Redacted` sentinel values in the SDK.

## Dependencies

- **`@openfga/sdk`** — OpenFGA client for ReBAC authorization checks and tuple writes.
- **`@openfoundry/spi`** — `AuditStore`, `ConsentManager`, `AuditRecord` type contracts.
- **`@openfoundry/observability`** — OpenTelemetry tracing and structured logging.
- **`jose`** — JWT/JWK operations for OIDC token validation and key rotation.

## Used By

- [[api-gateway]] — All API requests pass through `OidcAuthenticator` for token validation, `AuthorizationService` for ReBAC checks, and `ConsentService` for consent evaluation. Every action execution writes through `AuditWriter`.
- [[action-executor]] — Uses the security layer's `PermissionResult` and `AuditWriter` contracts during the pipeline.

## Key Design Decisions

- **ReBAC over RBAC/ABAC** — Relationship-Based Access Control (via OpenFGA) was chosen over traditional RBAC or ABAC because it naturally models operational hierarchies (e.g., "clinician X can see patient Y because patient Y is admitted to ward Z and clinician X is assigned to ward Z"). This enables fine-grained, context-aware permissions without explosion of role definitions.
- **CIS2 out of the box** — The `CIS2_ROLE_MAPPINGS` constant provides pre-configured NHS Smartcard role resolution. Additional identity providers are supported through the `RoleMappingConfig` interface.
- **Healthcare consent exemptions** — The consent manager includes built-in direct-care exemptions (emergency access, ward-scoped implicit consent) required for healthcare use cases while maintaining GDPR compliance for non-care purposes.
- **Immutable audit** — Audit records are append-only and write-once. The `AuditWriter` accepts records and stores them, but no API exists to modify or delete audit entries. This preserves the chain of accountability.

## Test Coverage

- **5 test files**: `oidc-authenticator.test.ts` (OIDC auth), `role-mapping.test.ts` (CIS2 role resolution), `authorization-service.test.ts` (ReBAC checks), `audit.test.ts` (audit writing/querying), `consent-service.test.ts` (consent decisions).

## Sources

- [Source: open-foundry-spec-v2.md Section 7 — Security and Governance]
- [Source: open-foundry-spec-v2.md Section 7.1 — Access Control Model (ReBAC)]
- [Source: open-foundry-spec-v2.md Section 7.2 — Audit Trail]
- [Source: open-foundry-spec-v2.md Section 7.3 — Consent Management]
- [Source: open-foundry-spec-v2.md Section 7.4 — Authentication (OIDC)]
- [Source: open-foundry-spec-v2.md Section 7.5 — Multi-Tenancy Model]
