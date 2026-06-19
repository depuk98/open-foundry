---
title: ADR-003 — ReBAC via OpenFGA Instead of Static RBAC
created: 2026-06-18
last_updated: 2026-06-18
type: decision
status: accepted
related_components:
  - security-service
  - api-gateway
  - odl-compiler
---

# ADR-003: ReBAC via OpenFGA Instead of Static RBAC

## Context

Open Foundry models real-world operational systems where access control must reflect dynamic relationships — a clinician can access patients on their ward, a consultant can discharge patients under their care, and permissions change automatically as relationships change (patient moves ward, consultant reassigned). Traditional Role-Based Access Control (RBAC) with static role-permission tables cannot express these relationship-driven rules without manual updates and complex workarounds.

## Decision

**Relationship-Based Access Control (ReBAC) implemented via OpenFGA (Google Zanzibar).** The authorization model is defined in OpenFGA DSL and auto-generated from the ODL schema by the compiler. Permissions are derived from the ontology graph itself — a user's access to an object depends on their relationship to that object in the graph, not on a static role assignment.

The model encodes rules like: a user assigned to a ward (`assigned` relation) can view and edit patients admitted to that ward (`viewer from admitted_to`). A user designated as a patient's clinician can discharge that patient (`can_discharge: clinician`). When a patient is transferred to a different ward, their visibility set changes automatically — no manual permission updates.

## Alternatives Considered

- **Static RBAC** — Role tables with permission assignments. Rejected because: (1) Cannot express relationship-derived rules — "can view patients on your ward" requires joining role tables with ward-patient links, which duplicates what the ontology already knows. (2) Manual permission updates when relationships change (patient transferred → admin must update role assignments). (3) Does not scale to fine-grained field-level and action-level permissions without combinatorial role explosion.
- **Oso / OPA (Policy-as-Code)** — General-purpose policy engines. Rejected because: While powerful, they are not graph-native. Expressing relationship traversal rules ("user who is assigned to ward W can view patients admitted to ward W") requires manual graph traversal logic in policy code, which duplicates the ontology engine's traversal capabilities. OpenFGA evaluates these natively via its relationship tuples and `userset` rewrites.
- **Custom ReBAC engine** — Build an in-house ReBAC implementation. Rejected because: Reinventing a Google Zanzibar implementation is a multi-year engineering effort. OpenFGA is the CNCF-graduated reference implementation of the Zanzibar paper, battle-tested at scale, with a rich DSL, `ListObjects` API for batched permission filtering, and < 5ms p99 check latency.

## Consequences

### What becomes easier

- **Permissions auto-adapt** — When a patient is transferred between wards (via the [[actions|Action Framework]]), the link changes. The OpenFGA model reevaluates based on the new link state. No manual permission updates. No stale access grants.
- **Four-tier permission model** — The ODL compiler generates permissions at: (1) Schema level (which ObjectTypes/properties a role can access), (2) Object level (which instances, derived from graph relationships), (3) Action level (which ActionTypes a role can execute), (4) Field level (which properties are visible/editable). See [[rebec-authorization]].
- **Auto-generated from ODL** — The OpenFGA DSL model is generated from ODL directives and link type definitions. Domain pack authors define object types and links; the compiler produces the corresponding authorization model. No separate auth model maintenance.
- **Bathed permission checks** — OpenFGA's `ListObjects` API enables the Security Layer to pre-compute the set of accessible object IDs for a user and object type in a single call, then intersect with query results. This replaces N per-object checks with O(1) calls per query.
- **Field-level redaction** — The API returns unpermitted fields as `null` with `_redactedFields` metadata. The TypeScript SDK types redacted fields as `T | null | Redacted` for compile-time safety.

### What becomes harder

- **Operational dependency** — OpenFGA becomes a critical infrastructure dependency. The circuit breaker fails closed (all permission checks return denied when OpenFGA is unavailable). An OpenFGA outage means the platform cannot authorize any operation.
- **Model complexity** — Relationship-based models can become complex as domain packs add object types and relationships. The compiler-generated model handles common patterns, but manually authored model extensions (e.g., `nhs-roles.fga` in the NHS domain pack) require ReBAC expertise.
- **Debugging authorization failures** — Understanding why a permission was denied requires tracing the relationship graph. The audit trail records the denial reason, but debugging complex relation chains (e.g., `user → assigned → ward → admitted_to → patient → clinician`) requires familiarity with the OpenFGA model structure.

## Sources

- [Source: open-foundry-spec-v2.md Section 7.1 — Access Control Model]
- [Source: open-foundry-spec-v2.md Section 7.1.5 — Permission Check Batching]
- [Source: open-foundry-spec-v2.md Section 7.1.6 — Security Layer Circuit Breaker]
- [Source: README.md — Security: OpenFGA ReBAC]
- [Source: README.md — Design Principle #5: Federation-first]

## Related

- [[rebec-authorization]] — Concept page on ReBAC and how OpenFGA implements it
- [[security-service]] — The Security Layer that implements auth, ReBAC, consent, and audit
- [[adr-005-action-pipeline]] — How authorization fits into the mandatory action pipeline
