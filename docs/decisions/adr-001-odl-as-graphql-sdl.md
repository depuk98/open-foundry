---
title: ADR-001 — ODL Extends GraphQL SDL Instead of Custom DSL
created: 2026-06-18
last_updated: 2026-06-18
type: decision
status: accepted
related_components:
  - odl-compiler
  - api-gateway
  - sdk
---

# ADR-001: ODL Extends GraphQL SDL Instead of Custom DSL

## Context

Open Foundry needed a schema language to define its ontology — object types, link types, action types, and functions. The schema language is the single source of truth from which APIs, permissions, SDKs, and UI components are generated. We had to choose between designing a custom domain-specific language (DSL) or extending an existing standard.

## Decision

**ODL (Ontology Definition Language) extends GraphQL SDL with semantic directives.** Any valid `.odl` file is a valid `.graphql` file. Open Foundry-specific semantics — object types, link types, action types, computed fields, and constraints — are expressed through custom directives (`@objectType`, `@linkType`, `@actionType`, `@function`, `@primary`, `@unique`, `@indexed`, `@computed`, `@constraint`, `@immutable`, `@sensitive`, etc.).

The ODL compiler parses standard GraphQL SDL, validates the directive semantics, and generates a complete GraphQL API, REST endpoints, OpenFGA authorization model, TypeScript SDK, and API contract artifacts (OpenAPI, AsyncAPI).

## Alternatives Considered

- **Custom DSL** — Would allow unbounded expressiveness tailored to the ontology domain. Rejected because: steep learning curve for developers, no existing tooling (linters, formatters, IDE plugins), and every integration point (API generation, SDK generation) would need a custom parser and code generator built from scratch.
- **JSON Schema** — Mature and widely supported. Rejected because: JSON Schema is optimized for document validation, not graph relationships or semantic typing. It lacks native support for links, actions, functions, and interface inheritance, all of which are first-class in ODL.
- **Protobuf / gRPC IDL** — Strongly typed and performant. Rejected because: Protobuf is not designed for human-authored schema that evolves frequently during domain modeling. The syntax is verbose for entity definition and lacks GraphQL's natural mapping to query APIs. Protobuf is used for [[federation-gateway]] transport but not for ontology definition.

## Consequences

### What becomes easier

- **Zero learning curve for schema authors** — Developers already know GraphQL SDL syntax. The ODL directives are additive semantics on a familiar foundation.
- **Existing tooling works out of the box** — GraphQL linters, formatters, syntax highlighters, and IDE plugins (Apollo, GraphQL Foundation) work on `.odl` files without modification.
- **Direct API generation** — The compiled schema maps directly to a GraphQL API with zero transformation overhead. The REST API, FHIR facade, and TypeScript SDK are generated from the same compiled schema.
- **Ecosystem compatibility** — Apollo Server 4, GraphQL Code Generator, and similar tools can consume the compiled schema. See [[api-gateway]] and [[sdk]].
- **Deterministic compilation** — For a given ODL schema and `StorageCapabilities` profile, the compiler produces the same GraphQL API every time. This enables reproducible builds and schema diffing.

### What becomes harder

- **Directive proliferation** — As the platform grows, the set of directives expands (currently 17 directives). Each new capability may require a new directive. The compiler must validate directive interactions (e.g., `@immutable` on `@computed` fields is rejected). See [[adr-005-action-pipeline]] for how constraints tie into the action system.
- **GraphQL SDL limitations** — GraphQL SDL was not designed for schema versioning, namespace management, or migration planning. These are handled outside the SDL grammar (via YAML manifests and the schema registry). The `@namespace` directive bridges this gap but is not a native GraphQL concept.

## Sources

- [Source: open-foundry-spec-v2.md Section 2 — Ontology Definition Language]
- [Source: README.md — ODL Schema Example]
- [Source: README.md — Design Principle #6: Schema-driven]

## Related

- [[odl-schema-driven]] — Concept page on ODL as single source of truth
- [[adr-004-spi-storage-abstraction]] — How the SPI interacts with ODL-defined types
- [[adr-005-action-pipeline]] — How action types defined in ODL are executed
