---
title: ADR-006 — Overlay Mode for Phased Rollout
created: 2026-06-18
last_updated: 2026-06-18
type: decision
status: accepted
related_components:
  - sync-engine
  - ontology-engine
  - api-gateway
---

# ADR-006: Overlay Mode for Phased Rollout

## Context

Deploying Open Foundry at an NHS trust requires connecting to existing source systems (PAS, EPR, labs). A full data migration — extracting source data, transforming it, and loading it into the ontology store — is a high-risk, high-effort operation: it requires production database access, data quality validation, downtime coordination, and rollback planning. Trusts need to demonstrate value before committing to full ingestion. We needed a lower-friction adoption path.

## Decision

**Overlay mode — a read-through ingestion mode that maps existing source system schemas to ODL types in real time, without extracting or storing data in the ontology store.** When the Ontology Engine receives a query for an overlay-mapped ObjectType, it delegates to the connector in real time, applies the mapping transforms, and returns the result as if it were a native ontology object.

Overlay results are cached locally (TTL-based, default 5 minutes). Overlay objects participate in the full security pipeline — ReBAC checks, field redaction, consent checks — identically to native objects. The source system is not aware of Open Foundry's permission model. Overlay objects are read-only by default; write-back is opt-in and requires the connector to implement a `write` method.

A datasource can be migrated from `OVERLAY` to `CDC`/`POLLING`/`BATCH` mode without changing the ODL schema. The migration triggers a full extract that populates the ontology store, after which the overlay cache is disabled.

## Alternatives Considered

- **Always require full extraction** — Every datasource must be fully ingested before the ontology can query it. Rejected because: high barrier to adoption, requires production database access authorization, full extracts on large source systems can take hours or days, and trusts are unlikely to commit resources without first seeing value from the platform.
- **Internal-only queries against source systems** — Build a parallel query interface that reads from source systems but does not participate in the ontology. Rejected because: it does not demonstrate the ontology's value proposition (unified graph queries, ReBAC, consent), and creates a two-tier data model that complicates the platform architecture.
- **Lightweight ETL batch extracts** — Run periodic batch extracts into a staging area. Rejected because: adds latency, requires separate storage, and does not provide the real-time query experience that overlay mode offers. Batch extracts are supported as a separate sync mode for when full ingestion is desired.

## Consequences

### What becomes easier

- **Faster time-to-value** — A trust can connect a PAS datasource in overlay mode in hours, not weeks. Queries, dashboards, and governed actions (read-only) work immediately against live data. This aligns with the NHS pilot goal of demonstrating an "FDP-compatible, trust-controlled ontology runtime."
- **Phased adoption path** — Overlay → CDC migration is a deliberate, reversible step. Trusts can operate in overlay mode for weeks or months, validate the ontology model and security posture, then migrate to CDC when ready. The ODL schema does not change — the sync mode configuration does.
- **Lower operational risk** — Overlay mode does not create a copy of source data. There is no data synchronization drift to manage, no duplicate storage costs, and no risk of stale data (within the TTL cache window). The source system remains the authoritative system of record.
- **Security parity** — Overlay objects go through identical ReBAC, consent, and field-redaction checks as native objects. The trust's governance model applies uniformly regardless of whether data lives in the ontology store or is read through from a source system.

### What becomes harder

- **Read-only limitation** — Overlay objects cannot be mutated through the Action Framework. Attempting to execute an action against an overlay object returns `OVERLAY_READ_ONLY`. This limits the platform's value proposition (governed actions, digital twin mutations) until the trust migrates to CDC.
- **No version history or lineage** — Overlay objects have no version histories or lineage records. Lineage is reported as `{ kind: 'OVERLAY', connector, sourceSystem, sourcePointer }` without field-level provenance. For compliance use cases requiring full audit trails, CDC migration is necessary.
- **Cache staleness** — With a 5-minute TTL, overlay queries can return stale data. The cache is time-based only — there is no CDC-driven cache invalidation in overlay mode. This is acceptable for dashboards and read-only queries but not for real-time clinical decision support.
- **Connector load** — Every ontology query against overlay objects translates to a connector request against the source system. High query volumes can load the source database. Rate limiting (`maxRecordsPerSecond`) and circuit breaker protection apply, but the source system's capacity is the bottleneck.

## Sources

- [Source: open-foundry-spec-v2.md Section 6.4 — Overlay Ingestion Mode]
- [Source: open-foundry-spec-v2.md Section 6.4.1 — Overlay Semantics]
- [Source: README.md — Roadmap: Schema Registry persistence]
- [Source: docs/fdp-plan.md — Conformance boundary]

## Related

- [[cdc-sync-pattern]] — Concept page on CDC via Debezium for full ingestion
- [[connector-pattern]] — Concept page on connector plugin architecture
- [[adr-004-spi-storage-abstraction]] — How overlay data bypasses local SPI storage
- [[sync-engine]] — The Sync Engine that implements overlay mode
