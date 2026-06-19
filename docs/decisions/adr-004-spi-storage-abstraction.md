---
title: ADR-004 — Storage-Agnostic SPI with Pluggable Providers
created: 2026-06-18
last_updated: 2026-06-18
type: decision
status: accepted
related_components:
  - spi
  - storage-memory
  - storage-postgres
  - ontology-engine
---

# ADR-004: Storage-Agnostic SPI with Pluggable Providers

## Context

Open Foundry needs to persist ontology objects, links, schemas, and audit records. Different deployment contexts have different storage requirements: NHS trusts are standardized on PostgreSQL, research environments may prefer TypeDB for inference, and development/testing needs an in-memory provider for speed. Hardcoding to a single database would limit adoption and violate the platform's composability principle.

## Decision

**All persistence goes through a Storage Provider Interface (SPI) — a TypeScript interface defining ~25 operations across schemas, objects, links, transactions, versioning, indices, and health.** The `@openfoundry/spi` package defines the core type contracts (`OntologyObject`, `OntologyLink`, `FilterExpression`, `StorageProvider`, `Transaction`, `StorageCapabilities`). Every database backend implements this interface. The Ontology Engine never calls a database directly — it calls the SPI.

The project ships two reference implementations:
- `@openfoundry/storage-postgres` — PostgreSQL 17 + Apache AGE for graph traversal. Production target.
- `@openfoundry/storage-memory` — In-memory implementation. For tests and development.

Third parties can implement additional providers (TypeDB, Neo4j) by implementing the SPI contract and passing the conformance suite.

## Alternatives Considered

- **Hardcode to PostgreSQL** — Simplest implementation path. Rejected because: violates composability principle, creates vendor lock-in, prevents future providers (TypeDB inference, Neo4j graph queries) that may be better suited for specific deployments. The NHS itself has trusts on different database stacks.
- **ORM abstraction (e.g., Prisma, TypeORM)** — Provides database portability. Rejected because: ORMs are designed for relational CRUD, not graph operations. Link traversal, graph queries (AGE), and temporal versioning require database-specific features that ORMs abstract away. The SPI is a higher-level abstraction that treats the database as a persistence service, not a row store.
- **No abstraction — each layer owns its storage** — Each platform layer manages its own persistence. Rejected because: violates ACID transaction boundaries across objects and links (a single action must atomically create objects, update links, and write audit records). A unified SPI ensures all mutations in a single action share a transaction.

## Consequences

### What becomes easier

- **Deployment flexibility** — NHS trusts can deploy on their existing PostgreSQL infrastructure. Teams evaluating the platform can start with the in-memory provider for development. Research environments can swap in TypeDB when inference capabilities are ready.
- **Conformance-guaranteed behavior** — The SPI conformance suite (287 tests across 10 categories) ensures every provider behaves identically for all required operations. Capability-gated features (full-text search, graph traversal, temporal queries) are advertised via `StorageCapabilities` and the API surface adapts accordingly.
- **Capability-gated API** — The ODL compiler generates different GraphQL schema surfaces depending on the active provider's capabilities. If `supportsFullTextSearch: false`, `searchFoos` queries are omitted. If `supportsGraphTraversal: false`, traversal queries are omitted. Clients never see unavailable operations.
- **SPI as integration contract** — Third-party provider authors implement one interface and pass one conformance suite. They do not need to understand the Ontology Engine internals, the Security Layer, or the Action Framework.
- **Transaction-per-action** — The SPI's `beginTransaction()` returns a `Transaction` object that bundles all write operations. A single Action execution maps to a single SPI transaction — all effects either commit together or roll back. See [[adr-005-action-pipeline]].

### What becomes harder

- **Interface overhead** — Every database operation goes through an abstraction layer. While negligible for most operations, the SPI adds a thin indirection that complicates stack traces during debugging.
- **Provider complexity** — Implementing a storage provider requires understanding the SPI contract in detail (soft-delete semantics, optimistic concurrency, referential integrity, link cardinality enforcement, transaction isolation). The conformance suite validates this, but the initial implementation cost is non-trivial.
- **Capability inconsistency** — Different providers support different capabilities. An application developed against PostgreSQL (with full-text search) may not work identically against the in-memory provider (which advertises `supportsFullTextSearch: false`). Teams must test against their target provider.

## Sources

- [Source: open-foundry-spec-v2.md Section 3 — Storage Provider Interface]
- [Source: open-foundry-spec-v2.md Section 3.7 — Provider Implementations]
- [Source: open-foundry-spec-v2.md Section 11.1 — SPI Conformance Suite]
- [Source: README.md — Storage Provider Interface]
- [Source: README.md — Design Principle #3: Storage-agnostic]

## Related

- [[spi]] — The SPI package defining core type contracts
- [[storage-memory]] — In-memory SPI implementation for testing
- [[storage-postgres]] — PostgreSQL 17 + Apache AGE SPI implementation
- [[adr-006-overlay-mode]] — How overlay mode interacts with the SPI (read-through, no local storage)
