---
title: Security Architecture
created: 2026-06-18
last_updated: 2026-06-18
type: synthesis
status: active
related_components:
  - security-service
  - api-gateway
  - action-executor
  - ontology-engine
related_decisions:
  - adr-003-rebac-via-openfga
  - adr-005-action-pipeline
---

# Security Architecture

Open Foundry enforces defense-in-depth across four security layers: authentication, authorization, consent, and audit. Every request traverses all four before any data is returned or mutated.

## End-to-End Security Flow

```
Request → OIDC Auth → ReBAC Check → Consent Check → Action Execution → Audit
  │            │            │              │               │            │
  │    [[security-service]] │              │    [[action-executor]]    │
  │    JWT validation       │    OpenFGA   │    Consent    │  Immutable │
  │    JWKS auto-rotation   │    per-type  │    multi-     │  append-   │
  │    tenant extraction    │    per-field │    tenant     │  only log  │
  └─────────────────────────┴──────────────┴───────────────┴────────────┘
```

## Authentication (OIDC)

The [[security-service]] validates JWT access tokens against an OIDC provider (Keycloak by default). Key requirements:

- **`aud` claim** must match the configured client ID
- **`tenant_id` claim** is mandatory — every request is tenant-scoped
- **`roles` claim** must be a flat top-level array (not nested in `realm_access`)
- **JWKS auto-rotation** — public keys are fetched periodically
- **Development mode** — bypasses auth with a synthetic admin user (`tenantId: 'default'`)

## Authorization (ReBAC via OpenFGA)

Relationship-Based Access Control via [[adr-003-rebac-via-openfga|OpenFGA]] replaces static RBAC roles. Permissions are derived from the relationship graph:

```
Type: patient
  relations:
    define clinician: [user]
    define viewer: clinician or nurse_in_charge
    define can_discharge: clinician
```

Key features:
- **Four-tier model**: `who` (user) → `relation` (clinician) → `object` (patient)
- **Per-type checks**: each ObjectType has its own relation definitions
- **Per-field redaction**: sensitive fields stripped based on viewer permissions
- **Link-derived tuples**: creating a link (e.g., `AdmittedTo`) auto-provisions ReBAC tuples
- **Dev mode**: all checks pass (`allow-all stub`)

See [[rebec-authorization]] for the full concept page.

## Consent Management

Multi-tenant consent with healthcare direct-care exemptions:
- Patients (or their representatives) can grant/revoke consent for data access
- `DIRECT_CARE` exemption bypasses consent for treating clinicians
- Consent records are persisted in PostgreSQL (production) or in-memory (development)
- Consent denials return partial results (redacted/excluded objects)

## Action Pipeline Security

Every mutation traverses the mandatory pipeline defined in [[adr-005-action-pipeline]]:

```
validate → authorize → consent → preconditions (CEL) → execute → side-effects → audit → emit
```

Multiple independent authorization checks:
1. **OpenFGA ReBAC** — `can_<verb>` check on the target object
2. **CEL precondition** — `actor.hasRole('clinician')` in the action manifest

Both must pass. A denied action at the authorize or consent stage IS audited (with `result: 'denied'`).

## Audit Trail

The [[security-service]] maintains an **immutable, append-only audit log** for every mutation:
- All creates, updates, deletes, and link operations
- Actor, roles, tenant, trace ID
- Denied actions are also audited (authorize + consent stages)
- Precondition failures and input validation failures are NOT audited

## CORS & Rate Limiting

- **CORS**: fail-closed in production (explicit allowed origins)
- **Rate limiting**: four tiers — IP (300/min), tenant (1000/min), principal (200/min), client app (500/min)
- Redis-backed distributed limiter in production, in-memory fallback for single-pod

## Container Security

All Docker images follow security hardening:
- Non-root containers with read-only root filesystems
- Dropped capabilities
- Network policies (default-deny with explicit allow rules)
- Secrets loaded from Kubernetes Secrets (never in images)

## Sources

- [Source: open-foundry-spec-v2.md Section 9] — Security layer specification
- [Source: open-foundry-spec-v2.md Section 9.1] — Authentication
- [Source: open-foundry-spec-v2.md Section 9.2] — Authorization (ReBAC)
- [Source: open-foundry-spec-v2.md Section 9.3] — Consent management
- [Source: open-foundry-spec-v2.md Section 9.4] — Audit trail
- [Source: deploy/README.md] — Deployment security
