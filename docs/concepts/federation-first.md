---
title: Federation-First Architecture
created: 2026-06-18
last_updated: 2026-06-18
type: concept
status: active
related_components:
  - federation-gateway
  - security-service
  - api-gateway
---

# Federation-First Architecture

Open Foundry is designed **federation-first** — multi-instance, multi-tenant operation is an architectural primitive, not a feature bolted on later. Every design decision, from tenant-scoped SPI operations to Data Sharing Agreement (DSA) enforcement, assumes that multiple Open Foundry instances will share data selectively across organizational boundaries.

## What Federation Means in Open Foundry

Federation is the ability for multiple independent Open Foundry instances (e.g., `nhs-trust-leeds` and `nhs-trust-bradford`) to share data under explicit, machine-readable contracts while maintaining full sovereignty over their data, permissions, and audit trails.

Key properties:
- **No central authority** — Instances register with each other explicitly. There is no automatic discovery, no shared control plane, no super-admin.
- **Explicit contracts** — Every cross-instance data access is governed by a Data Sharing Agreement (DSA) signed by both instances. No data moves without a machine-readable purpose, scope, and access control policy.
- **Sovereign enforcement** — The provider instance (data owner) enforces the DSA's access control and consent conditions. The consumer instance cannot bypass them. The provider's ReBAC and consent model always applies.
- **Dual audit** — Both instances write immutable audit records for every cross-instance access. Auditors at either trust can trace what data was shared, with whom, for what purpose, and with what consent decision.

## Multi-Tenancy as Foundation

Federation builds on Open Foundry's multi-tenancy model:

- **Shared control plane + logically isolated tenant data planes.**
- Every request carries a required `tenantId` enforced at the SPI level.
- Security tuples (OpenFGA) are isolated per tenant.
- Events are partitioned by tenant.
- Audit records include `tenantId` and are queryable only within tenant boundary.

Federation is instance-to-instance and tenant-scoped. Cross-tenant federation within the same instance is forbidden unless explicitly bridged by an admin-controlled export workflow.

## Data Sharing Agreements (DSAs)

A DSA is a machine-readable YAML contract that defines:

```yaml
agreement:
  id: "dsa-001"
  tenantScope:
    providerTenant: "acute-leeds"
    consumerTenant: "acute-bradford"
  parties:
    - instance: "nhs-trust-leeds"
      role: PROVIDER
    - instance: "nhs-trust-bradford"
      role: CONSUMER

  purposes:
    - DIRECT_CARE  # Patient transfers between trusts

  scope:
    objectTypes:
      - Patient:
          fields: [id, nhsNumber, name, dateOfBirth, status]
          filter: "status == 'ACTIVE'"
      - AdmittedTo:
          fields: [admissionDate, expectedDischarge]

  accessControl:
    - type: authorisation
      expr: "consumer.actor.hasRole('clinician')"
      error: "Only clinicians can access cross-trust patient data"

  consentConditions:
    - type: consent
      expr: "patient.hasConsent(DIRECT_CARE) || purpose == DIRECT_CARE"
      onDenial: REDACT  # REDACT | EXCLUDE | REJECT

  pagination:
    maxPageSize: 100
    defaultPageSize: 20

  audit: BOTH_PARTIES
  expires: "2027-02-06"
```

### DSA Enforcement

- **Access control** — Evaluated by the provider instance. Failure returns HTTP 403. The consumer cannot override.
- **Consent conditions** — Evaluated by the provider instance. Failure returns partial results (redacted or excluded objects) depending on `onDenial` policy. This is distinct from access control — a clinician may be authorized but the data subject may have withheld consent.
- **Field filtering** — Only DSA-scoped fields are returned. The provider instance strips fields not listed in the DSA scope.
- **Pagination caps** — Requests exceeding `maxPageSize` are silently capped by the provider.

## Cross-Instance Query Flow

```
User at Leeds queries patients at Bradford:
  1. User submits query through local instance (Leeds API).
  2. Leeds identifies the query targets a remote instance (Bradford).
  3. Leeds checks the DSA — is Bradford authorized to receive this query?
  4. Leeds forwards the request with the user's identity, tenant context, purpose,
     and pagination parameters to Bradford's federation gateway (mTLS + gRPC).
  5. Bradford validates the DSA, evaluates access control conditions,
     evaluates consent conditions, applies field filtering, and returns paginated results.
  6. Both instances write audit records.
  7. Leeds returns results to the user.
```

Cross-instance queries are **synchronous request/response over mTLS + gRPC**. The federation gateway handles connection pooling, retries, and circuit breaking. If Bradford is unavailable, Leeds returns a partial result with per-target error metadata — the local instance remains available.

## Federated Aggregation

For analytics where individual-level data should not leave the source instance (e.g., national waiting list statistics), Open Foundry supports federated aggregation:

1. A coordinating instance sends an aggregation query to all participating instances.
2. Each instance evaluates the aggregation locally (count, group-by, sum) and returns only the aggregate result.
3. The coordinator combines results.
4. Privacy-enhancing techniques (differential privacy with configurable epsilon, k-anonymity with minimum group size suppression) are applied at the source instance before results leave.

## Object Handoff

When an entity moves between instances (e.g., a patient transferred from Leeds to Bradford):

1. Source (Leeds) creates an encrypted **handoff record** with the object state and relevant links.
2. Handoff is sent to the destination (Bradford) via the federation gateway.
3. Destination (Bradford) creates a local copy and acknowledges receipt.
4. Source (Leeds) marks the object as `TRANSFERRED` and stores a reference to Bradford.
5. Both instances audit the handoff.

Conflict handling: If Bradford already has an object with the same identity, the handoff is rejected with `HANDOFF_CONFLICT` and both instances are notified. Handoff conflicts must not be auto-resolved — they require manual operator intervention.

## Instance Identity

Each Open Foundry instance has:
- A globally unique **instance ID** (UUID).
- A human-readable **instance name** (e.g., `nhs-trust-leeds`).
- A **federation endpoint** URL for inter-instance communication.
- A **public key** for mutual authentication (mTLS or JWT).

Instances register with each other explicitly. There is no automatic discovery — this is a security requirement, not a convenience feature.

## Sources

- [Source: open-foundry-spec-v2.md Section 9 — Federation Protocol]
- [Source: open-foundry-spec-v2.md Section 9.2 — Data Sharing Agreements]
- [Source: open-foundry-spec-v2.md Section 9.3 — Cross-Instance Query]
- [Source: open-foundry-spec-v2.md Section 9.4 — Federated Aggregation]
- [Source: open-foundry-spec-v2.md Section 9.5 — Object Handoff]
- [Source: open-foundry-spec-v2.md Section 7.5 — Multi-Tenancy Model]
- [Source: README.md — Design Principle #5: Federation-first]

## Related

- [[rebec-authorization]] — How ReBAC governs cross-instance access control in DSAs
- [[action-orientation]] — How actions can be invoked across instances via federation
- [[cdc-sync-pattern]] — How CDC synchronizes data within an instance before federation shares it
- [[adr-003-rebac-via-openfga]] — How OpenFGA's permission model supports multi-tenant federation
