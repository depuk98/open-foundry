---
title: ODL Schema-Driven Architecture
created: 2026-06-18
last_updated: 2026-06-18
type: concept
status: active
related_components:
  - odl-compiler
  - api-gateway
  - sdk
  - security-service
---

# ODL Schema-Driven Architecture

ODL (Ontology Definition Language) is the **single source of truth** for the entire Open Foundry platform. Every API endpoint, permission rule, SDK method, and UI binding is generated from the ODL schema. This is not just documentation generation — it is a compiler pipeline that produces executable artifacts.

## The Compiler Pipeline

```
ODL Schema (.odl files)
    │
    ▼
ODL Compiler (TypeScript)
    │
    ├──► GraphQL API schema (Apollo Server 4)
    │      ├── Query types (getById, list, search, typeahead)
    │      ├── Mutation types (per-ActionType mutations)
    │      └── Subscription types (per-ObjectType change events)
    │
    ├──► REST API routes
    │      ├── GET /api/v1/{objectType} — list, get, links, history
    │      └── POST /api/v1/actions/{actionType} — governed actions
    │
    ├──► OpenFGA Authorization Model
    │      ├── Per-type relations (viewer, editor, can_discharge)
    │      └── Relationship-derived permissions (viewer from admitted_to)
    │
    ├──► TypeScript Client SDK
    │      ├── Typed object queries (of.Patient.get, of.Patient.list)
    │      ├── Typed action invocations (of.actions.dischargePatient)
    │      ├── Redacted-field type safety (T | null | Redacted)
    │      └── Subscription bindings (of.Patient.onChange)
    │
    └──► API Contract Artifacts
           ├── OpenAPI 3.0.3 (REST contract)
           ├── GraphQL SDL (introspection contract)
           └── AsyncAPI 2.6.0 (event/subscription contract)
```

Every generated artifact is **deterministic** — the same ODL schema + `StorageCapabilities` profile always produces the same output. This enables reproducible builds, schema diffing, and CI-verified API contract consistency.

## What the Schema Defines

The ODL schema, written as `.odl` files (which are valid `.graphql` files), defines:

### Object Types
Entities in the operational domain (Patient, Ward, Bed, Transaction). Declared with `@objectType`. Every ObjectType has exactly one `@primary` field (globally unique identifier). Fields can have directives for indexing (`@indexed`), uniqueness (`@unique`), immutability (`@immutable`), sensitive marking (`@sensitive`), and computed derivation (`@computed`).

### Link Types
First-class relationships between ObjectTypes with their own identity (ID), properties, and cardinality constraints. Declared with `@linkType(from, to, cardinality)`. Links are not simple foreign keys — they carry properties (e.g., `admissionDate` on `AdmittedTo`) and have independent lifecycles.

### Action Types
Validated, auditable mutations. Declared with `@actionType`. Each ActionType defines its input parameters via `@param` fields. The action's behavior (preconditions, effects, side-effects) is defined in a companion YAML manifest. See [[action-orientation]].

### Functions
Named, sandboxed, read-only computations over ontology objects. Declared with `@function(runtime, entry)`. Functions run in WASM or V8 isolate sandboxes with resource limits and no ambient filesystem/network access.

### Interfaces
Shared shapes that ObjectTypes implement. The core pack provides `Identifiable`, `Auditable`, `Locatable`, and `Temporal`. Interface inheritance works identically to GraphQL interfaces.

## Directives — The Semantic Layer

ODL's expressiveness comes from its directives. These are not GraphQL-standard — they are Open Foundry extensions that add ontology semantics to the SDL syntax:

| Directive | Purpose |
|-----------|---------|
| `@objectType` | Marks a type as an ontology entity |
| `@linkType(from, to, cardinality)` | Defines a relationship type |
| `@actionType` | Marks a type as a governed mutation |
| `@function(runtime, entry)` | Marks a type as a sandboxed computation |
| `@primary` | Globally unique identifier field |
| `@unique` | Enforces uniqueness across all instances |
| `@indexed` | Creates structured index for fast lookup |
| `@computed(fn, args, cache, ttl)` | Field value derived from a function |
| `@constraint(expr)` | CEL validation expression (field or type level) |
| `@immutable` | Field value cannot change after creation |
| `@sensitive` | Affects logging and access control |
| `@searchable(weight, analyzer)` | Full-text index inclusion |
| `@terminology(system)` | Binds a CodeableConcept to a terminology system |

See [[adr-001-odl-as-graphql-sdl]] for why ODL extends GraphQL SDL instead of using a custom DSL.

## Schema Lifecycle

The ODL compiler enforces a disciplined schema lifecycle:
1. **Author** — Write or modify `.odl` files.
2. **Validate** — Check type consistency, directive correctness, link cardinality, constraint expressions.
3. **Diff** — Compute migration diff (additions, modifications, removals). Generate reverse diff for rollback.
4. **Classify** — SAFE (additive), COMPATIBLE (backward-compatible), or BREAKING (requires migration plan).
5. **Apply** — Safe/compatible changes auto-applied. Breaking changes require an explicit migration plan with CEL-based transforms.
6. **Version** — Applied schema stored in registry as immutable, versioned snapshot.

Schema versions are monotonic and forward-only. Rollback is achieved by applying a reverse diff as a new, higher-numbered version.

## Why Schema-Driven Matters

This principle eliminates entire categories of drift:
- **API never diverges from schema** — The API is compiled from the schema, not hand-written.
- **Permissions never stale** — The OpenFGA model is regenerated when object types or links change.
- **SDKs always current** — The TypeScript SDK is regenerated; redacted-field types are compile-time safe.
- **Documentation is executable** — The schema IS the documentation. The generated OpenAPI and GraphQL SDL are machine-readable contracts.

## Sources

- [Source: open-foundry-spec-v2.md Section 2 — Ontology Definition Language]
- [Source: open-foundry-spec-v2.md Section 2.5 — Schema Lifecycle]
- [Source: README.md — Design Principle #6: Schema-driven]
- [Source: README.md — ODL Schema Example]
- [Source: AGENTS.md — Key Technical Concepts: ODL]

## Related

- [[adr-001-odl-as-graphql-sdl]] — Decision record on why ODL extends GraphQL SDL
- [[domain-pack-architecture]] — How domain packs compose ODL schemas
- [[action-orientation]] — How ActionTypes defined in ODL govern all mutations
- [[rebec-authorization]] — How OpenFGA models are generated from ODL link types
