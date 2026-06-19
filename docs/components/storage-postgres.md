---
title: Storage Postgres (PostgreSQL+AGE SPI)
created: 2026-06-18
last_updated: 2026-06-18
type: component
package: "@openfoundry/storage-postgres"
status: active
related_components:
  - spi
  - odl
  - ontology-engine
  - api-gateway
  - storage-memory
  - observability-library
---

# Storage Postgres (PostgreSQL+AGE SPI)

The `@openfoundry/storage-postgres` package provides the **production-grade persistence backend** for the Open Foundry platform. It implements the full `StorageProvider` interface from [[spi]] on PostgreSQL 17 with the Apache AGE (1.5) graph extension. This delivers all standard RDBMS capabilities (ACID transactions, B-tree indexes, full-text search via `tsvector`, temporal queries) alongside native graph traversal for relationship-heavy ontology operations. It is the default production storage provider.

## Public API

**StorageProvider Implementation:**
- `PostgresStorageProvider` — Full `StorageProvider` implementation backed by PostgreSQL+AGE. Accepts `PostgresStorageConfig` (connection pool settings, tenant isolation, soft-delete behavior).
- `PostgresStorageConfig` — Configuration type: connection string, pool size, timeouts (connect 5s, idle 30s, statement 30s), schema name.

**Schema / DDL Generation:**
- `generateDDL(schema, options)` → `GeneratedDDL` — Produces idempotent DDL from ODL schema: object tables, link tables, AGE graph setup, node/edge labels, audit tables, consent tables, lineage tables, and indexes.
- `generateObjectTableDDL`, `generateLinkTableDDL`, `generateAllGraphDDL`, `generateGraphSetupDDL`, `generateNodeLabelDDL`, `generateEdgeLabelDDL`, `generateAuditDDL`, `generateConsentDDL`, `generateLineageDDL` — Individual DDL generators.
- `pgType(fieldType)`, `pgIdent(name)`, `snakeCase(name)`, `pgIndexMethod(type)` — SQL-generation utilities.
- Types: `DDLGenerationOptions`, `GeneratedDDL`.

**Object CRUD:**
- `createObject`, `getObject`, `updateObject`, `softDeleteObject`, `hardDeleteObject`, `queryObjects` — Direct SQL operations with parameterized queries (prevents SQL injection).
- `filterToSql(filter)` → `SqlFragment` — Compiles `FilterExpression` to parameterized SQL WHERE clauses.
- Types: `SqlFragment` (SQL string + parameter values).

**Link CRUD:**
- `createLink`, `getLink`, `updateLink`, `deleteLink`, `getLinks`, `traverse` — Link operations with AGE Cypher queries for graph traversal.
- Traversal supports configurable depth (max 10) and node limits (max 10,000).

**Temporal Queries:**
- `getObjectAtVersion(type, id, version)` — Point-in-time object retrieval by version number.
- `getObjectAtTime(type, id, timestamp)` — Point-in-time object retrieval by timestamp.

**Persistent Stores:**
- `PostgresAuditStore` — PostgreSQL-backed `AuditStore` for immutable audit trail.
- `PostgresConsentStore` — PostgreSQL-backed `ConsentStore` for multi-tenant consent records.
- `PostgresSchemaRegistry` — PostgreSQL-backed `SchemaRegistry` with advisory-lock-serialized schema migrations.
- `PostgresObjectSetStore` — PostgreSQL-backed `ObjectSetStore` for persistent object sets.

**Transactions & Resilience:**
- `PgTransaction` — PostgreSQL transaction handle with `commit()`/`rollback()`. Supports configurable isolation levels.
- `resolveQueryable(pool, tx?)` — Resolves the correct queryable (pool or transaction) for an operation.
- `withRetry(fn, options)` — Retry wrapper with exponential backoff for transient database errors.
- Types: `Queryable`, `RetryOptions`.

## Dependencies

- **`pg`** — `node-postgres` for PostgreSQL client connectivity (connection pooling, parameterized queries).
- **`@openfoundry/spi`** — Implements `StorageProvider` and consumes all SPI types.
- **`@openfoundry/odl`** — Uses `ObjectTypeDefinition`/`LinkTypeDefinition` for DDL generation and type mapping.
- **`@openfoundry/observability`** — OpenTelemetry tracing and structured logging.

## Used By

- [[api-gateway]] — Production deployments boot with `PostgresStorageProvider` as the persistence layer (when `DATABASE_URL` is configured).
- The platform's Integration Test Harness (`tests/integration-tests`) runs 110 integration tests against a live PostgreSQL+AGE instance.

## Key Design Decisions

- **PostgreSQL with AGE over dedicated graph DB** — The platform uses PostgreSQL as the primary store with Apache AGE for graph traversal. This avoids operational complexity of running a separate graph database while still providing native Cypher-based graph queries. The AGE extension runs inside PostgreSQL, keeping all data in one database.
- **Parameterized queries only** — All SQL queries are parameterized (`$1`, `$2`, ...). No string interpolation of user values. This prevents SQL injection at the architectural level.
- **Idempotent DDL** — `generateDDL` produces `CREATE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` statements, safe to run repeatedly. Schema changes that don't introduce breaking changes can be applied incrementally without manual migration scripts.
- **Advisory locks for schema migration** — `PostgresSchemaRegistry` uses PostgreSQL advisory locks to serialize concurrent schema migration attempts, preventing race conditions in multi-pod deployments.

## Test Coverage

- **12 test files**: `ddl-generation.test.ts` (DDL correctness), `object-crud.integration.test.ts`, `link-crud.integration.test.ts` (object/link CRUD against live PG), `traversal.test.ts` (AGE graph traversal), `temporal-queries.test.ts` (version/time queries), `filter-to-sql.test.ts` (filter compilation), `field-col.test.ts`, `pg-transaction.test.ts`, `audit-store.integration.test.ts`, `consent-store.integration.test.ts` (should be similar), `schema-registry.integration.test.ts`, `object-set-store.integration.test.ts`, `provider-lifecycle.integration.test.ts`.
- Integration tests require `PG_TEST_URL` environment variable pointing to a PostgreSQL 17 + AGE 1.5 instance.

## Sources

- [Source: open-foundry-spec-v2.md Section 3 — Storage Provider Interface]
- [Source: open-foundry-spec-v2.md Section 3.7 — Provider Implementations]
- [Source: open-foundry-spec-v2.md Section 3.8 — Bulk Mutation Contract]
- [Source: open-foundry-spec-v2.md Section 3.9 — Backup and Restore Contract]
- [Source: open-foundry-spec-v2.md Section 11.2 — Integration Test Harness]
