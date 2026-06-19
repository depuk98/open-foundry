---
title: ODL (Ontology Definition Language)
created: 2026-06-18
last_updated: 2026-06-18
type: component
package: "@openfoundry/odl"
status: active
related_components:
  - spi
  - ontology-engine
  - action-executor
  - api-gateway
  - security-service
  - sdk-typescript
  - storage-postgres
---

# ODL (Ontology Definition Language)

The `@openfoundry/odl` package is the **schema compiler and code generation engine** for the Open Foundry platform. It parses GraphQL SDL files extended with Open Foundry semantic directives (`@objectType`, `@linkType`, `@actionType`, `@primary`, `@unique`, `@computed`, etc.) into a structured `ParsedSchema` AST, validates structural correctness, and generates downstream artifacts: a GraphQL API schema, an OpenFGA authorization model, a TypeScript SDK, and DDL for storage providers. It is the single source of truth: every API, permission, SDK, and database table is derived from ODL schema files.

## Public API

**Parser:**
- `parseOdl(files)` — Parses ODL `.graphql` files into a `ParsedSchema` AST. Exposes 50+ AST types: `ParsedSchema`, `ObjectType`, `LinkType`, `ActionType`, `FieldDefinition`, `Cardinality`, `Direction`, all directive types (`@primary`, `@unique`, `@computed`, `@sensitive`, `@readonly`, `@immutable`, `@deprecated`, `@terminology`, `@searchable`, etc.), and `EnumDefinition`/`InterfaceDefinition`/`ScalarDefinition`.

**Validator:**
- `validateSchema(schema)` → `ValidationResult` — Structural and semantic validation with `ValidationIssue[]` and `ValidationSeverity` (ERROR/WARNING).

**Code Generation:**
- `generateGraphQLSchema(schema)` — Produces a complete executable `GraphQLSchema` (queries, mutations, subscriptions, filtering, pagination, aggregation).
- `generateOpenFGASchema(schema)`, `generateOpenFGAModel(schema)` — Generates OpenFGA ReBAC authorization type definitions and model DSL.
- `renderOpenFGADSL(model)` — Renders OpenFGA model to DSL string.
- `mergeOpenFGAOverrides(base, overrides)` — Merges domain-pack-specific permission overrides into the base model.
- `generateSdk(schema)` → `SdkOutput` — Generates typed TypeScript SDK source from the schema.

**Schema Diff & Migration:**
- `diff(oldSchema, newSchema)` → `SchemaDiff` — Computes structural changes (type additions/removals, field additions/removals/modifications, enum value changes, link modifications).
- `classify(diff)` → `MigrationClass` (SAFE | BREAKING).
- `reverseDiff(diff)` → `SchemaDiff` — Produces the inverse diff for downgrade support.

**Schema Registry:**
- `InMemorySchemaRegistry` — Implements `SchemaRegistry` interface for development: stores versioned schemas, compares diffs, gates breaking changes behind migration plans. Type: `SchemaRegistry`, `SchemaVersion`, `ApplySchemaOptions`, `MigrationPlan`.

**CLI:**
- `odl` binary (via `bin.odl` in package.json, powered by `commander`) for command-line schema compilation.

## Dependencies

- **`graphql`** — Core GraphQL AST types and schema building (v16.10+).
- **`commander`** — CLI argument parsing.
- **`@openfoundry/spi`** (dev) — Compile-time type references.

## Used By

- [[ontology-engine]] — Uses parsed `ObjectType`, `LinkType`, and `FieldDefinition` to drive validation and computed fields.
- [[action-executor]] — Uses `ActionType` definitions and `ParsedSchema` for action manifest parsing.
- [[api-gateway]] — Uses `generateGraphQLSchema`, `parseOdl`, and schema registry to boot the Apollo server with auto-generated resolvers.
- [[security-service]] — Uses `generateOpenFGAModel` and `mergeOpenFGAOverrides` to produce ReBAC models.
- [[sdk-typescript]] — Consumed by `generateSdk` to produce typed client code.
- [[storage-postgres]] — Uses `ObjectTypeDefinition` and `LinkTypeDefinition` to drive `generateDDL`.

## Key Design Decisions

- **GraphQL SDL as base** — ODL extends standard GraphQL SDL rather than inventing a new syntax. Existing IDE tooling (linters, formatters, syntax highlighters) works out of the box. The `@directive` mechanism carries Open Foundry-specific semantics without breaking GraphQL compatibility.
- **Schema-driven everything** — APIs, permissions, SDKs, and DDL are generated from one schema. This is the single source of truth principle: changing the schema changes everything downstream, eliminating drift between layers.
- **Safe vs Breaking diffs** — The `classify()` function automates migration risk assessment. SAFE changes (field additions, new types) apply automatically; BREAKING changes (field removals, type removals, cardinality changes) require an approved migration plan, gated through the schema registry.

## Test Coverage

- **8 test files**: `parser.test.ts`, `validator.test.ts`, `codegen.test.ts`, `sdk-codegen.test.ts`, `openfga.test.ts`, `diff.test.ts`, `registry.test.ts`, `cli.test.ts`.

## Sources

- [Source: open-foundry-spec-v2.md Section 2 — Ontology Definition Language (ODL)]
- [Source: open-foundry-spec-v2.md Section 2.1 — Core Types (ObjectTypes, LinkTypes, ActionTypes, Functions)]
- [Source: open-foundry-spec-v2.md Section 2.2 — Scalar Types]
- [Source: open-foundry-spec-v2.md Section 2.3 — Directives Reference]
- [Source: open-foundry-spec-v2.md Section 2.4 — Namespaces]
- [Source: open-foundry-spec-v2.md Section 2.5 — Schema Lifecycle]
