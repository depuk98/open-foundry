---
title: ReBAC Authorization via OpenFGA
created: 2026-06-18
last_updated: 2026-06-18
type: concept
status: active
related_components:
  - security-service
  - api-gateway
  - odl-compiler
---

# ReBAC Authorization via OpenFGA

**Relationship-Based Access Control (ReBAC)** is the authorization model of Open Foundry. Unlike static Role-Based Access Control (RBAC), where permissions are assigned via role-permission tables, ReBAC derives permissions from the relationships in the ontology graph. If a user has a relationship to an object, they gain the permissions that relationship confers.

## How ReBAC Works in Open Foundry

The core idea: **who you are to an object determines what you can do with it.**

```
User "Dr. Smith" is assigned to Ward A
    → Dr. Smith can view Ward A
    → Dr. Smith can view patients admitted to Ward A
        (because "viewer from admitted_to" propagates permissions)
    → Dr. Smith can edit patients admitted to Ward A
        (because "editor from assigned" propagates edit permissions)

Patient "John" is admitted to Ward A
    → When John is transferred to Ward B:
        → Dr. Smith loses visibility of John
        → Dr. Jones (assigned to Ward B) gains visibility
        → NO manual permission updates required
```

Permissions are **computed at request time** based on the current graph state, not stored in static tables. This means a patient transfer (executed through the [[actions|Action Framework]]) automatically changes who can access that patient's data — without any administrator intervention.

## OpenFGA Implementation

Open Foundry implements ReBAC using **OpenFGA**, the CNCF-graduated reference implementation of Google's Zanzibar paper. The authorization model is defined in OpenFGA's DSL and is **auto-generated from the ODL schema**.

### Generated Model Example

Given these ODL definitions:

```graphql
type Ward @objectType { id: ID! @primary, name: String! }
type Patient @objectType { id: ID! @primary, name: String! }
type AdmittedTo @linkType(from: "Patient", to: "Ward", cardinality: MANY_TO_ONE)
```

The ODL compiler generates:

```
type user

type ward
  relations
    define assigned: [user]
    define viewer: assigned
    define editor: assigned

type patient
  relations
    define admitted_to: [ward]
    define viewer: viewer from admitted_to
    define editor: editor from admitted_to
    define clinician: [user]
    define can_discharge: clinician
```

The `viewer from admitted_to` syntax means: if a user is a viewer of the ward that this patient is admitted to, they are also a viewer of the patient. This is a **relationship traversal** — permissions follow the graph.

## Four-Tier Permission Model

Open Foundry's ReBAC implementation enforces permissions at four levels:

### 1. Schema-Level Permissions
Which ObjectTypes and properties a role can access. "Analysts can read `Patient` but not the `clinicalNotes` field."

### 2. Object-Level Permissions
Which specific instances a user can access, derived from graph relationships. "Nurse Alice can see patients on her assigned ward." This is the core ReBAC value proposition — instance-level access derived from the ontology graph.

### 3. Action-Level Permissions
Which ActionTypes a role can execute on which objects. "Only consultants can execute `ScheduleSurgery`." "A clinician can execute `DischargePatient` on patients where they have the `clinician` relation."

### 4. Field-Level Permissions
Which properties are visible or editable per role. "Receptionists can see `name` and `dateOfBirth` but not `clinicalNotes`." Unpermitted fields are returned as `null` with `_redactedFields` metadata.

## Permission Check Flow

Every API request goes through:

1. **Authenticate** — Validate OIDC token, resolve identity to an OpenFGA `user`.
2. **Batch pre-compute** — For list queries, use OpenFGA's `ListObjects` API to get the set of accessible object IDs in one call (not N per-object checks).
3. **Evaluate per-object** — For each requested object, run `check(user, permission, object)`.
4. **Apply field-level** — For permitted objects, redact impermissible fields. Cache field-level results per (user, role-set, object-type) for the request duration.
5. **Consent filter** — If consent manager is active, apply consent decisions on top of ReBAC results.

The Security Layer maintains a **circuit breaker** for OpenFGA. If OpenFGA becomes unavailable, all permission checks return **denied** (fail-closed). The system never degrades to "allow all."

## Consent Integration

Consent is a separate step in the action pipeline (after Authorization, before Preconditions). A user can be authorized to perform an action (they have the `can_discharge` permission) but the specific data subject may have withheld consent for that purpose. For NHS deployments, the Healthcare Domain Pack configures a **direct care exemption** — when the purpose is `DIRECT_CARE` and the actor has a legitimate ReBAC relationship with the patient, consent is presumed.

## Sources

- [Source: open-foundry-spec-v2.md Section 7.1 — Access Control Model]
- [Source: open-foundry-spec-v2.md Section 7.1.3 — Field-Level Security Behaviour]
- [Source: open-foundry-spec-v2.md Section 7.1.5 — Permission Check Batching]
- [Source: open-foundry-spec-v2.md Section 7.3 — Consent Management]
- [Source: README.md — Security: OpenFGA ReBAC]
- [Source: AGENTS.md — Key Technical Concepts: ReBAC]

## Related

- [[adr-003-rebac-via-openfga]] — Decision record on why ReBAC via OpenFGA, not static RBAC
- [[odl-schema-driven]] — How ODL generates the OpenFGA authorization model
- [[action-orientation]] — How ReBAC gates the Authorize step in the action pipeline
- [[cel-expressions]] — How CEL precondition expressions interact with ReBAC (e.g., `actor.hasRole`)
