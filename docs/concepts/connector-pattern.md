---
title: Connector Plugin Architecture
created: 2026-06-18
last_updated: 2026-06-18
type: concept
status: active
related_components:
  - sync-engine
  - ontology-engine
---

# Connector Plugin Architecture

**Connectors** are the plugin interface by which Open Foundry connects to external source systems. They implement a defined TypeScript interface (`Connector`) and are registered declaratively via datasource binding YAML configurations within Domain Packs. The Sync Engine loads connectors at runtime and orchestrates the extract → map → resolve → apply pipeline.

## The Connector Interface

Every connector implements this contract:

```typescript
interface Connector {
  // Identity
  name: string;
  version: string;

  // Lifecycle
  initialize(config: ConnectorConfig): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;

  // Discovery
  discoverSchema(): Promise<SourceSchema>;

  // Extraction
  fullExtract(table: string, options?: ExtractOptions): AsyncIterable<SourceRecord>;
  incrementalExtract(table: string, since: Checkpoint): AsyncIterable<SourceRecord>;

  // Backpressure
  pause(): Promise<void>;
  resume(): Promise<void>;

  // Writeback (optional)
  write?(record: WritebackRecord): Promise<WritebackResult>;
}
```

The interface is designed around **pull-based consumption** — the Sync Engine requests the next batch only when it has capacity. Connectors do not push data faster than the engine pulls.

## Reference Connectors

Open Foundry ships with the following built-in connectors:

| Connector | Protocol | Mode Support | Notes |
|-----------|----------|-------------|-------|
| **jdbc** | JDBC (any SQL DB) | CDC, POLLING, BATCH, OVERLAY | CDC via Debezium. Polling fallback. |
| **fhir** | FHIR R4 REST | POLLING, BATCH | Maps FHIR Resources to ObjectTypes natively. |
| **hl7v2** | MLLP / TCP | CDC (stream) | Parses ADT, ORM, ORU message types. |
| **csv** | File system | BATCH | Watches a directory for manual imports. |
| **rest** | HTTP REST | POLLING, BATCH | Generic REST API connector with configurable auth. |
| **kafka** | Kafka consumer | CDC (stream) | Consumes events from existing Kafka topics. |
| **nhs-spine** | NHS Spine SMSP | POLLING | PDS (demographics), SDS (directory), e-RS (referrals). |

## Connector Lifecycle

1. **Registration** — Connector configs are declared in Domain Pack YAML files (`connectors/nhs-spine.yaml`) and loaded at startup.
2. **Initialization** — The Sync Engine calls `initialize(config)` with the connector's configuration (connection URL, credentials, table mappings).
3. **Discovery** — `discoverSchema()` introspects the source schema so the Sync Engine can validate mapping configurations.
4. **Extraction** — `fullExtract()` runs the initial load; `incrementalExtract()` handles steady-state CDC. Both return `AsyncIterable<SourceRecord>`.
5. **Backpressure** — `pause()` and `resume()` are called by the Sync Engine's circuit breaker when the Ontology Engine is overloaded.
6. **Shutdown** — `shutdown()` gracefully closes connections, commits consumer offsets, and flushes buffers.

## Datasource Binding

A connector's configuration is separate from its type. A Domain Pack declares datasource bindings that pair a connector with a specific source system:

```yaml
datasource: PAS_Patients
connector: jdbc                      # ← References the jdbc connector implementation
connection:
  url: "jdbc:postgresql://pas-db:5432/pas"
  table: "patients"

mapping:
  objectType: Patient
  primaryKey:
    source: "patient_id"
    transform: "prefix('patient-')"
  properties:
    nhsNumber: { source: "nhs_no" }
    name: { source: "surname", transform: "concat(title, ' ', forename, ' ', surname)" }

sync:
  mode: CDC                          # CDC | POLLING | BATCH | OVERLAY
  conflictResolution: SOURCE_PRIORITY
  rateLimit:
    maxRecordsPerSecond: 500
```

The `mapping` section defines how source columns map to ODL properties. A rich set of transform functions (`concat`, `prefix`, `parseDate`, `ifPresent`, `map`, `lookup`, `hash`, `custom`) handles schema impedance mismatch between the source system and the ontology.

## Connector Quality Rules

Third-party connectors may be implemented outside the monorepo. To be compatible, a connector must:
1. Implement the `Connector` interface faithfully (sync-engine type checks at load time).
2. Pass the connector health contract (`healthCheck()` returns within 5 seconds).
3. Handle `pause()` and `resume()` gracefully — not just no-op them.
4. Support at least one extraction mode (full extract). CDC and writeback are optional.
5. Respect the rate limit configuration passed via `ExtractOptions`.

The Sync Engine loads connectors from registered directories at startup. Unknown connector types referenced in datasource bindings produce a warning and skip that binding.

## Security

Connectors run with their own identity in the audit trail (`actor.type: 'connector'`). Synced data carries provenance metadata identifying the connector, source system, sync run ID, and mapping version. Connector credentials are loaded from Kubernetes Secrets or Vault — never hardcoded in YAML configs.

## Sources

- [Source: open-foundry-spec-v2.md Section 6.1 — Connector Interface]
- [Source: open-foundry-spec-v2.md Section 6.3 — Datasource Mapping]
- [Source: open-foundry-spec-v2.md Section 6.7 — Reference Connectors]
- [Source: README.md — Sync Engine: JDBC connectors, Debezium CDC]
- [Source: README.md — Domain Packs table]

## Related

- [[cdc-sync-pattern]] — How the JDBC connector implements CDC via Debezium
- [[domain-pack-architecture]] — How connectors are bundled into domain packs
- [[adr-006-overlay-mode]] — How overlay mode uses connectors for read-through without local storage
- [[sync-engine]] — The Sync Engine that orchestrates connectors
