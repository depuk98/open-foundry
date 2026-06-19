---
title: Storage Memory (In-Memory SPI)
created: 2026-06-18
last_updated: 2026-06-18
type: component
package: "@openfoundry/storage-memory"
status: active
related_components:
  - spi
  - ontology-engine
  - action-executor
  - api-gateway
  - storage-postgres
---

# Storage Memory (In-Memory SPI)

The `@openfoundry/storage-memory` package provides a **fully in-memory implementation** of the `StorageProvider` interface defined by [[spi]]. It is designed for fast, deterministic unit testing, local development without external infrastructure, and as a reference implementation for future storage backends. It satisfies the complete SPI contract including object/link CRUD, transactions, version history, temporal queries, full-text search, aggregation, and bulk mutations — all in process memory.

## Public API

- `MemoryStorageProvider` — The sole export. Instantiate with no configuration to get a fully functional `StorageProvider`. All data is stored in JavaScript `Map` objects. No persistence between restarts.

**Capabilities:**
- Object CRUD (create, read, update, soft-delete, hard-delete, query with filters, pagination)
- Link CRUD (create, read, update, delete, query by direction, cardinality enforcement)
- Graph traversal (in-memory graph walks with same depth/node limits as production)
- Transactions (in-memory `Transaction` with commit/rollback)
- Version history (full object versioning with `getObjectAtVersion` and `getObjectAtTime`)
- Index management (in-memory index creation and querying)
- Full-text search (in-memory string matching)
- Aggregation queries (count, sum, avg, min, max, group-by)
- Bulk mutations (atomic batch operations)
- Health check (always healthy if instantiated)
- Event emission (supports pluggable event listeners)

## Dependencies

- **`@openfoundry/spi`** — Implements the `StorageProvider` interface using SPI types.
- **No other runtime dependencies.** Pure in-memory data structures (Map, Set, Array).

## Used By

- [[ontology-engine]] (dev) — Test suites for `ObjectManager` and `LinkManager`.
- [[action-executor]] (dev) — Test suites for `ActionExecutor` pipeline.
- [[api-gateway]] — Development mode boots with `MemoryStorageProvider` when no database is configured.
- `tests/spi-conformance` — The SPI Conformance Suite (287 tests, 10 categories) validates `MemoryStorageProvider` as its primary target, ensuring it faithfully implements the full SPI contract.
- `tests/pilot-scenarios` — NHS pilot scenario tests.

## Key Design Decisions

- **Reference implementation** — `MemoryStorageProvider` serves as the canonical reference for SPI behavior. If `[[storage-postgres]]` produces different results for the same operations, the memory provider is considered correct (it runs the conformance suite as ground truth).
- **No external dependencies** — No database, no file system, no network. This enables deterministic, parallel test execution with zero setup.
- **Identical contract surface** — Every SPI operation is implemented. There are no stubs or "not implemented" methods. This allows any code written against the SPI to work identically in test and production.

## Test Coverage

- **2 test files**: `memory-storage-provider.test.ts` (unit tests for the implementation), `search-regression.test.ts` (search-specific regression tests).
- **287 SPI conformance tests** (in `tests/spi-conformance`) additionally validate it against the full SPI contract.

## Sources

- [Source: open-foundry-spec-v2.md Section 3 — Storage Provider Interface]
- [Source: open-foundry-spec-v2.md Section 3.7 — Provider Implementations]
- [Source: open-foundry-spec-v2.md Section 11.1 — SPI Conformance Suite]
