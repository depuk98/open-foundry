---
title: CDC Sync Pattern via Debezium
created: 2026-06-18
last_updated: 2026-06-18
type: concept
status: active
related_components:
  - sync-engine
  - ontology-engine
---

# CDC Sync Pattern via Debezium

**Change Data Capture (CDC)** is the primary synchronization pattern used by Open Foundry to keep the ontology in sync with external source systems in steady-state operation. CDC captures row-level changes (INSERT, UPDATE, DELETE) from source databases as they happen and streams them to the Sync Engine, which maps them to ontology objects and applies them through the action pipeline.

## The CDC Pipeline

```
Source DB (e.g., PAS PostgreSQL)
    │
    ▼ (WAL / replication slot)
Debezium Connector (Kafka Connect)
    │
    ▼ (Kafka topic: pas.public.patients)
Sync Engine (JDBC connector + CDC consumer)
    │
    ├──► Extract: Read change events from Kafka
    ├──► Map: Apply datasource mapping transforms
    │        (source columns → ODL properties)
    ├──► Resolve: Conflict resolution (SOURCE_PRIORITY, LAST_WRITE_WINS)
    └──► Apply: Write to ontology store via SPI
             (with tenant scoping, versioning, lineage capture)
```

## CDC vs. Other Sync Modes

Open Foundry supports four sync modes:

| Mode | Description | Use Case |
|------|-------------|----------|
| **CDC** | Real-time change capture via Debezium | Production steady-state. < 30s latency target. |
| **POLLING** | Periodic queries against source DB | Simple JDBC sources without CDC support |
| **BATCH** | Scheduled full or incremental extracts | Nightly reconciliation, data warehouse feeds |
| **OVERLAY** | Read-through, no local storage | Phased rollout, read-only dashboards |

## How the JDBC + Debezium Connector Works

The `jdbc` connector is the primary reference connector. It uses Debezium for CDC and falls back to JDBC polling when Debezium is unavailable.

### CDC Mode (Steady-State)

1. The Debezium connector is configured on the source database with a replication slot.
2. Change events (row-level INSERT/UPDATE/DELETE) are published to a Kafka topic.
3. The Sync Engine's CDC consumer reads from the Kafka topic.
4. Each event is mapped through the datasource mapping configuration (YAML) — source columns are transformed to ODL properties.
5. Mapped objects are written to the ontology store via the SPI.
6. Backpressure: the Sync Engine pulls records at a rate controlled by `rateLimit.maxRecordsPerSecond`. If the Ontology Engine is overloaded, a circuit breaker pauses all connectors.

### Full Extract (Initial Load)

1. The connector queries the source table with configurable batch size (default: 1000 rows).
2. Each batch is mapped and written to the ontology store.
3. Progress events (`openfoundry.sync.fullextract.progress`) report records processed and estimated time remaining.
4. Full extracts are not subject to the < 30s CDC latency target — they are expected to take significantly longer for large source tables.

## Datasource Mapping

Each sync datasource has a declarative YAML mapping that defines how source records become ontology objects:

```yaml
datasource: PAS_Patients
connector: jdbc
connection:
  url: "jdbc:postgresql://pas-db:5432/pas"
  table: "patients"

mapping:
  objectType: Patient
  primaryKey:
    source: "patient_id"
    target: "id"
    transform: "prefix('patient-')"
  properties:
    nhsNumber: { source: "nhs_no" }
    name: { source: "surname", transform: "concat(title, ' ', forename, ' ', surname)" }
    dateOfBirth: { source: "dob", transform: "parseDate('dd/MM/yyyy')" }
    status: { source: "discharge_date", transform: "ifPresent('DISCHARGED', 'ACTIVE')" }
  links:
    - linkType: AdmittedTo
      toType: Ward
      toKey:
        source: "ward_code"
        target: "id"
        transform: "prefix('ward-')"
      properties:
        admissionDate: { source: "admission_datetime" }
```

Transform functions include: `concat`, `prefix`, `parseDate`, `parseDateTime`, `ifPresent`, `coalesce`, `map`, `lookup`, `hash`, and `custom`.

## Conflict Resolution

When multiple sources provide conflicting data for the same object, the Sync Engine resolves conflicts using a configurable strategy:

| Strategy | Behavior |
|----------|----------|
| `LAST_WRITE_WINS` | Most recent timestamp wins (default) |
| `SOURCE_PRIORITY` | Configurable priority ordering of sources |
| `MERGE` | Non-conflicting fields merged; conflicting fields flagged |
| `CUSTOM` | Delegated to a registered resolution function |

Conflicts produce `openfoundry.sync.conflict` events with full details of both values and the resolution applied.

## Backpressure and Resilience

The Sync Engine implements backpressure to prevent overwhelming the Ontology Engine:

1. **Pull-based consumption** — Connectors provide `AsyncIterable<SourceRecord>`. The Sync Engine requests the next batch only when it has capacity.
2. **Rate limiting** — Each datasource can configure `maxRecordsPerSecond`, `maxConcurrentBatches`, and `burstSize`.
3. **Circuit breaker** — If the Ontology Engine's response latency exceeds a threshold, all connectors are paused. They resume when the engine recovers.
4. **Idempotency** — CDC events are at-least-once. Duplicate events are handled via idempotency keys.

## Security Context for Synced Data

Synced objects carry provenance metadata (`{ kind: 'SYNC', connector, sourceSystem, syncRunId, mappingVersion, sourcePointer }`). They participate in the full security pipeline — ReBAC checks, field redaction, consent — identically to user-created objects. The source system is not authoritative for access control; the ontology's permission model governs all access to synced data.

## Sources

- [Source: open-foundry-spec-v2.md Section 6 — Sync Engine]
- [Source: open-foundry-spec-v2.md Section 6.1 — Connector Interface]
- [Source: open-foundry-spec-v2.md Section 6.2 — Backpressure and Flow Control]
- [Source: open-foundry-spec-v2.md Section 6.3 — Datasource Mapping]
- [Source: open-foundry-spec-v2.md Section 6.6 — Conflict Resolution]
- [Source: README.md — Sync Engine: JDBC connectors, Debezium CDC]

## Related

- [[connector-pattern]] — Connector plugin architecture that powers CDC extraction
- [[adr-006-overlay-mode]] — How overlay mode differs from CDC (no local storage, read-only)
- [[domain-pack-architecture]] — How domain packs bundle connector configurations
- [[federation-first]] — Multi-instance design that CDC synchronizes within
