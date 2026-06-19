---
title: Sync Engine
created: 2026-06-18
last_updated: 2026-06-18
type: component
package: "@openfoundry/sync"
status: active
related_components:
  - spi
  - ontology-engine
  - api-gateway
  - observability-library
  - ner-extraction
---

# Sync Engine

The `@openfoundry/sync` package provides the **data synchronization layer** that keeps the Open Foundry ontology in sync with external source systems. It defines a pluggable connector interface, ships reference connector implementations (JDBC, REST, Twitter), provides a declarative mapping system to transform source records into ontology objects and links, supports Change Data Capture (CDC) via Debezium for real-time incremental sync, implements an overlay ingestion mode for read-only data projections, and includes a conflict resolution engine for concurrent writes from multiple sources. The Sync Engine is responsible for ingesting data from external systems into the ontology, but never bypasses the security and governance layers: all ingested data passes through the standard object/link lifecycle defined by [[ontology-engine]].

## Public API

**Connector Interface & Registry:**
- `Connector` (interface) — The pluggable connector contract: `initialize()`, `shutdown()`, `healthCheck()`, `discoverSchema()`, `fullExtract()`, `incrementalExtract()`, `pause()`, `resume()`, optional `write()`.
- `ConnectorRegistry` — Registers and discovers connector plugins. Supports `createDefaultRegistry()` with built-in connectors.
- `ConnectorFactory`, `ConnectorMetadata`, `ConnectorPlugin` — Plugin architecture types for external connector packages.
- Types: `ConnectorConfig`, `Checkpoint`, `ExtractOptions`, `SourceRecord`, `SourceSchema`, `SourceTableSchema`, `SourceColumnSchema`, `WritebackRecord`, `WritebackResult`.

**Built-in Connectors:**
- `JdbcConnector` + `jdbcPlugin` — JDBC connector for relational databases. Supports full and incremental extraction, schema discovery, and configurable batching.
- `RestConnector` + `restPlugin` — Generic REST API connector for HTTP-based source systems.
- `TwitterConnector` + `twitterPlugin` — Reference connector for social media data ingestion.
- `createDefaultRegistry()` — Returns a registry pre-populated with JDBC, REST, and Twitter plugins.

**Mapping System (Section 6.3):**
- `parseMappingConfig(yaml)` → `DatasourceMappingConfig` — Parses declarative YAML mapping configurations (`ObjectMapping`, `LinkMapping`, `PropertyMapping`).
- `RecordMapper` / `createRecordMapper(config)` — Transforms `SourceRecord` into `MappedObject`/`MappedLink` using configured property mappings and transform functions.
- Built-in transform functions: `concat`, `prefix`, `suffix`, `parseDate`, `parseDateTime`, `toUpper`, `toLower`, `trim`, `ifPresent`, `coalesce`, `map`, `custom`. Supports `registerCustomTransform`/`clearCustomTransforms` for user-defined transforms.
- Types: `TransformFn`, `SyncMode`, `ConflictResolution`, `RateLimitConfig`, `SyncConfig`, `ConnectionConfig`, `PrimaryKeyMapping`, `PropertyMapping`, `LinkKeyMapping`, `LinkMapping`, `ObjectMapping`, `DatasourceMappingConfig`, `MappedObject`, `MappedLink`.

**Overlay Ingestion (Section 6.4):**
- `OverlayEngine` — Ingests read-only source data as an "overlay" layer on the ontology. Source records are stored as provenance-tagged objects that can be queried alongside native ontology objects. Supports configurable overlay lineage tracking.
- Types: `OverlayEngineConfig`, `OverlayObject`, `OverlayLineage`.

**CDC Consumer (Change Data Capture):**
- `CdcConsumer` — Consumes CDC events (from Debezium) and applies them to the ontology via the overlay engine or direct object/link operations. Supports checkpoint persistence for at-least-once delivery.
- Types: `ChangeApplier`, `CheckpointStore`, `CdcStats`, `CdcConsumerConfig`.

**Conflict Resolution (Section 6.6):**
- `ConflictResolver` — Resolves conflicts when multiple sources write to the same object. Supports configurable strategies: `LAST_WRITE_WINS`, `SOURCE_PRIORITY`, `FIELD_MERGE`, `MANUAL`. Emits `ConflictEventData` for unresolved conflicts.
- Types: `ConflictStrategy`, `FieldRule`, `ConflictResolverConfig`, `IncomingValue`, `ExistingValue`, `FieldResolution`, `ConflictResolutionResult`, `ConflictEventData`, `ConflictEventHandler`.

**Identity Resolution:**
- `IdentityResolver` — Resolves identity across source systems (e.g., same patient in PAS and EPR). Supports configurable matching rules and quarantine for ambiguous matches.
- `QuarantineQueue` — Held records pending manual identity resolution.
- Types: `QualityViolation`, `IdentityConflictEvent`, `IdentityStore`, `QuarantineInput`, `QuarantineRecord`, `QuarantineQueryFilter`, `IdentityResolutionResult`, `IdentityResolverConfig`.

## Dependencies

- **`pg`** — PostgreSQL client for JDBC connector backends.
- **`@openfoundry/spi`** — `OntologyObject`, `OntologyLink`, `StorageProvider` types.
- **`@openfoundry/observability`** — Tracing and structured logging for sync operations.
- **`yaml`** — YAML parsing for mapping configurations.

## Used By

- [[api-gateway]] — The sync engine is started as part of the API server bootstrap when domain packs include connector configurations. Connectors run in the same Node.js process.
- Domain packs ([[nhs-acute-pilot]], AML, Supply Chain) declare connector configurations in their pack manifests that the sync engine loads at runtime.

## Key Design Decisions

- **Pluggable connector architecture** — Connectors implement the `Connector` interface and register as plugins. Domain packs can ship custom connectors without modifying the sync engine source code. The `ConnectorRegistry` discovers and loads plugins at runtime.
- **CDC for real-time sync** — Change Data Capture (via Debezium) enables incremental, near-real-time sync from source databases. The `CdcConsumer` processes CDC events and applies changes via the overlay engine, eliminating the need for periodic full re-extractions.
- **Overlay pattern for read-only data** — Source system data ingested via sync is stored as overlays: read-only, provenance-tagged objects. This preserves the distinction between native ontology objects (created/managed by the platform) and ingested data (owned by source systems), while making both queryable through the same API.
- **Conflict resolution is configurable per-mapping** — Different source systems can use different conflict strategies. A PAS connector might use `SOURCE_PRIORITY` for patient demographics while a lab system uses `LAST_WRITE_WINS` for test results.

## Test Coverage

- **8 test files**: `jdbc-connector.test.ts`, `rest-connector.test.ts`, `connector-registry.test.ts`, `identity.test.ts` (identity resolution), `mapping.test.ts` (mapping config and transforms), `overlay-engine.test.ts` (overlay ingestion), `cdc-consumer.test.ts` (CDC processing), `conflict-resolver.test.ts` (conflict resolution strategies).

## Sources

- [Source: open-foundry-spec-v2.md Section 6 — Sync Engine]
- [Source: open-foundry-spec-v2.md Section 6.1 — Connector Interface]
- [Source: open-foundry-spec-v2.md Section 6.2 — Backpressure and Flow Control]
- [Source: open-foundry-spec-v2.md Section 6.3 — Datasource Mapping]
- [Source: open-foundry-spec-v2.md Section 6.4 — Overlay Ingestion Mode]
- [Source: open-foundry-spec-v2.md Section 6.5 — Transform Functions]
- [Source: open-foundry-spec-v2.md Section 6.6 — Conflict Resolution]
- [Source: open-foundry-spec-v2.md Section 6.7 — Reference Connectors]
