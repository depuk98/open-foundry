---
title: SPI (Storage Provider Interface)
created: 2026-06-18
last_updated: 2026-06-18
type: component
package: "@openfoundry/spi"
status: active
related_components:
  - odl
  - ontology-engine
  - action-executor
  - api-gateway
  - security-service
  - storage-memory
  - storage-postgres
  - sync-engine
---

# SPI (Storage Provider Interface)

The `@openfoundry/spi` package is the **foundation type layer** of the Open Foundry platform. It defines all TypeScript type contracts — interfaces and type aliases — that every other package, storage provider, and platform component implements or consumes. No runtime logic lives here; it is pure type definitions. This ensures storage-agnostic persistence: any backend that satisfies the `StorageProvider` interface can serve as the platform's persistence layer.

## Public API

- **`StorageProvider`** — The core contract for persistence backends (object CRUD, link CRUD, transactions, versioning, indices, health check, capabilities).
- **`OntologyObject`, `OntologyLink`** — Canonical shapes for objects and relationships.
- **`FilterExpression`, `FieldPredicate`, `LogicalPredicate`** — Composable query filter types for `queryObjects`.
- **`TraversalPath`, `TraversalStep`, `TraversalOptions`, `TraversalResult`** — Graph traversal request/response types.
- **`QueryOptions`, `ObjectPage`, `LinkPage`** — Pagination and ordering.
- **`RequestContext`** — Per-request tenant, principal, and trace identity.
- **`BulkMutationRequest`, `BulkOperation`, `BulkMutationResult`** — Atomic batch mutation contracts (Section 3.8).
- **`Transaction`** — SPI-level transaction handle.
- **`OntologySchema`, `ObjectTypeDefinition`, `LinkTypeDefinition`, `PropertyDefinition`** — Schema representation types consumed by `applySchema`/`getSchema`.
- **`IndexDefinition`, `IndexType`, `MigrationResult`** — DDL and migration shapes.
- **`HealthStatus`, `StorageCapabilities`, `ReplicationCapability`** — Provider introspection.
- **`CloudEvent`, `CloudEventType`** — CNCF CloudEvents shape for all platform events (Section 4.2).
- **`AuditRecord`, `AuditStore`, `AuditFilter`, `AuditPage`** — Immutable audit trail contracts (Section 7.2).
- **`ConsentDecision`, `ConsentManager`, `ConsentRecord`, `FieldRestriction`, `DataPurpose`** — Consent management contracts (Section 7.3).
- **`FieldProvenance`, `ProvenanceSource`** — Field-level data lineage contracts (Section 4.6).
- **`BackupCapability`, `BackupOptions`, `RestoreResult`** — Backup/restore contracts (Section 3.9).
- **`ObjectSetDefinition`, `ObjectSetStore`** — Named, persistent collection types (Section 8.3).
- **`AggregateFunction`, `AggregateQuery`, `AggregateResult`** — Aggregation query types.
- **`SearchQuery`, `SearchHit`, `SearchResult`** — Full-text search types.
- **`DateTime`, `Duration`** — Custom scalar type aliases.
- **`ErrorCategory`, `ErrorCode`, `PlatformError`** — Unified error model (Section 8.8).

## Dependencies

- **None** — The SPI package has zero runtime dependencies. Only `vitest` as a devDependency for type-assertion tests.

## Used By

Every other package in the platform depends directly on `@openfoundry/spi`:
- [[ontology-engine]] — `ObjectManager` and `LinkManager` operate on `StorageProvider`, `OntologyObject`, `OntologyLink`.
- [[action-executor]] — `ActionExecutor` pipeline writes through `StorageProvider`, uses `BulkMutationRequest`.
- [[api-gateway]] — GraphQL/REST resolvers read/write through the SPI types.
- [[security-service]] — `AuditStore`, `ConsentManager` are SPI-defined contracts; the security package implements them.
- [[storage-memory]] — Implements `StorageProvider` for testing.
- [[storage-postgres]] — Implements `StorageProvider` for production.
- [[sync-engine]] — Connectors map external records into `OntologyObject`/`OntologyLink` shapes.

## Key Design Decisions

- **Type-only package** — No implementation, no dependencies. This prevents circular dependency issues and keeps the SPI the sole type authority. The SPI is the single source of truth for data shapes across all 12 platform packages.
- **Storage-agnostic by design** — The `StorageProvider` interface abstracts all persistence. [[storage-memory]] and [[storage-postgres]] are swappable implementations; future backends (TypeDB, Neo4j) require only implementing this interface.
- **CloudEvents for event envelope** — All platform events use the CNCF CloudEvents spec, ensuring interop with any eventing infrastructure (Redpanda, Kafka, in-memory bus).

## Test Coverage

- **1 test file** — `types.test.ts` (compile-time type assertion tests for the SPI contracts).
- The SPI's contracts are primarily validated through the SPI Conformance Suite (`tests/spi-conformance` — 287 tests across 10 categories), which exercises `StorageProvider` implementations against the defined interfaces.

## Sources

- [Source: open-foundry-spec-v2.md Section 3 — Storage Provider Interface]
- [Source: open-foundry-spec-v2.md Section 3.1 — SPI Operations]
- [Source: open-foundry-spec-v2.md Section 3.2 — Key Types]
- [Source: open-foundry-spec-v2.md Section 8.8 — Unified Error Model]
