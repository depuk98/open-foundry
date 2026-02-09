# Open Foundry

**An open-source ontology platform for building operational digital twins.**

Open Foundry provides the semantic, kinetic, and security layers needed to turn commodity data infrastructure into a coherent, queryable, actionable model of a real-world system. The platform is domain-neutral — domain-specific functionality is delivered through composable **Domain Packs**. The first Domain Pack targets NHS acute healthcare.

> Apache 2.0 licensed. No proprietary dependencies. Schema-driven. Storage-agnostic.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Query & API Layer                    │
│              (GraphQL, REST, FHIR R4, SDKs)             │
├─────────────────────────────────────────────────────────┤
│                    Action Framework                     │
│        (action types, CEL execution, side-effects)      │
├──────────────────────┬──────────────────────────────────┤
│   Security Layer     │        Sync Engine               │
│  (OpenFGA ReBAC,     │  (JDBC connectors, Debezium      │
│   consent, audit)    │   CDC, conflict resolution)      │
├──────────────────────┴──────────────────────────────────┤
│                    Ontology Engine                      │
│    (schema registry, object store, relationship index)  │
├─────────────────────────────────────────────────────────┤
│               Storage Provider Interface                │
│               (PostgreSQL+AGE | Memory)                 │
└─────────────────────────────────────────────────────────┘
```

Each layer communicates only with adjacent layers through defined interfaces. No layer bypasses the security stack.

### Core Concepts

**ODL (Ontology Definition Language)** — An extension of GraphQL SDL with semantic directives. Define object types, link types, and action types in a single schema language. The compiler generates GraphQL APIs, REST endpoints, OpenFGA authorization models, and TypeScript SDKs from the schema.

```graphql
type Patient @objectType {
  id: ID! @primary
  nhsNumber: String @unique @indexed
  name: String!
  status: PatientStatus!
  triageCategory: TriageCategory
}

link AdmittedTo @linkType(from: "Patient", to: "Ward", cardinality: ONE_TO_MANY)

action AdmitPatient @actionType {
  patientId: ID! @param
  wardId: ID! @param
}
```

**Storage Provider Interface (SPI)** — All persistence goes through a pluggable interface. The platform ships with PostgreSQL+AGE (graph + relational) for production and an in-memory provider for tests. The SPI covers schema management, CRUD, links, queries, transactions, temporal queries, lineage, and multi-tenancy.

**Action Framework** — Actions are transactional mutations defined in YAML manifests with CEL preconditions and effects. The pipeline runs: validate → authorise → consent → preconditions → execute → audit → emit. A Go gRPC sidecar handles CEL expression evaluation.

**Security** — OIDC authentication, OpenFGA ReBAC for relationship-based access control, field-level redaction, consent management with healthcare-specific direct-care exemptions, and an immutable audit trail.

---

## MVP: NHS Acute Pilot

The first vertical slice targets **NHS acute healthcare** — modelling patient flow through wards, beds, and consultants at an acute trust.

### What It Demonstrates

1. A live ontology modelling **patients, wards, beds, and consultants**
2. Real data flowing from a **PAS (Patient Administration System)** via JDBC/CDC
3. Clinicians executing **actions** (admit, discharge, transfer) through GraphQL
4. **ReBAC-enforced permissions** with ward-scoped visibility
5. An **immutable audit trail** for every operation
6. A **FHIR R4 read endpoint** for interoperability

### NHS Acute Domain Pack

| Type | Contents |
|------|----------|
| **Object Types** | Patient, Ward, Bed, Consultant, DischargeRecord |
| **Link Types** | AdmittedTo, OccupiesBed, UnderCareOf, ReferredBy |
| **Action Types** | AdmitPatient, DischargePatient, TransferWard |
| **Connectors** | PAS JDBC connector with CDC via Debezium |
| **Permissions** | OpenFGA role model for NHS clinical roles |

### Spec Compliance

**21 of 22** must-ship items implemented. The one partial item (Schema Registry persistence — git-backed + DB-cached) is stubbed with an in-memory implementation that preserves the interface contract for later expansion.

---

## Packages

The monorepo contains 17 packages across four workspace roots:

### Core Platform (`packages/`)

| Package | Purpose |
|---------|---------|
| `@openfoundry/spi` | Storage Provider Interface — core type definitions |
| `@openfoundry/odl` | ODL parser, validator, code generator, CLI |
| `@openfoundry/engine` | Object lifecycle, links, computed fields, events, lineage |
| `@openfoundry/actions` | Action execution pipeline, CEL integration, side-effects, tool registry |
| `@openfoundry/api` | GraphQL (Apollo), REST, FHIR R4, WebSocket subscriptions, governance |
| `@openfoundry/security` | OIDC auth, OpenFGA ReBAC, consent manager, audit trail |
| `@openfoundry/storage-memory` | In-memory SPI implementation (tests/dev) |
| `@openfoundry/storage-postgres` | PostgreSQL 17 + Apache AGE SPI implementation |
| `@openfoundry/sync` | JDBC connectors, Debezium CDC, overlay mode, conflict resolution |
| `@openfoundry/observability` | OpenTelemetry traces and metrics (OTLP export) |
| `@openfoundry/sdk` | Auto-generated TypeScript client SDK |
| `cel-evaluator` | Go gRPC sidecar for CEL expression evaluation |

### Domain Packs (`domain-packs/`)

| Pack | Namespace | Contents |
|------|-----------|----------|
| `@openfoundry/domain-pack-core` | `openfoundry.core` | Base interfaces, 6 custom scalars |
| `@openfoundry/domain-pack-nhs-acute` | `nhs.acute` | 7 ODL schemas, 3 actions, 1 connector, permissions |

### Tests (`tests/`)

| Package | Purpose |
|---------|---------|
| `@openfoundry/spi-conformance` | Reusable SPI conformance suite (253 tests, 8 categories) |
| `@openfoundry/pilot-scenarios` | NHS pilot scenario tests |
| `@openfoundry/integration-tests` | Full Docker Compose stack integration tests |

### Tools (`tools/`)

| Package | Purpose |
|---------|---------|
| `@openfoundry/seed-nhs-acute` | Synthetic NHS data generator (CLI, JSON, SQL output) |

---

## Getting Started

### Prerequisites

- Node.js >= 20.0.0
- pnpm 9.15+
- Docker & Docker Compose (for integration tests and local deployment)

### Install and Build

```bash
pnpm install
pnpm run build
```

### Run Tests

```bash
# Unit tests (all packages except integration)
pnpm run test

# Integration tests (requires Docker Compose stack)
pnpm run test:integration

# All tests
pnpm run test:all
```

### Local Development Stack

```bash
cd deploy
cp .env.example .env
docker compose up -d
./init-services.sh
```

This starts 12 services: PostgreSQL+AGE, RedPanda (Kafka), Debezium CDC, Keycloak (OIDC), OpenFGA (ReBAC), OpenTelemetry Collector, and 6 application services.

### Production Deployment

A Kubernetes Helm chart is provided:

```bash
helm install openfoundry deploy/helm/openfoundry \
  --namespace openfoundry \
  --create-namespace
```

---

## Test Coverage

| Suite | Tests |
|-------|-------|
| SPI Conformance | 253 |
| ODL Compiler | 270 |
| API Layer | 135 |
| Sync Engine | 131 |
| Actions Framework | 123 |
| Security | 99 |
| Postgres Storage | 97 |
| Engine | 73 |
| Memory Storage | 56 |
| Seed Tool | 52 |
| NHS Acute Pack | 51 |
| Pilot Scenarios | 41 |
| SPI Types | 16 |
| Observability | 16 |
| Core Pack | 14 |
| **Total** | **1,372+** |

91 Postgres integration tests are skipped when no database is available. This is expected.

---

## Design Principles

1. **Open source** — Apache 2.0 licence. No proprietary dependencies.
2. **Composable** — every layer is independently replaceable via defined interfaces.
3. **Storage-agnostic** — all persistence goes through the SPI. No hardcoded database.
4. **Standards-native** — GraphQL, CloudEvents, OpenTelemetry, OIDC, FHIR.
5. **Federation-first** — multi-instance, multi-tenant from day one.
6. **Schema-driven** — the ontology schema is the single source of truth.
7. **Observable** — structured traces, metrics, and logs via OpenTelemetry.

---

## Known Deferrals

These items are specified in the full technical spec but intentionally deferred from the MVP. Interfaces are present; implementations are stubbed.

| Item | Current State | Impact |
|------|--------------|--------|
| Schema Registry persistence | In-memory only | Schemas lost on restart |
| Audit Trail persistence | In-memory only | Audit data lost on restart |
| Rate limiting (distributed) | In-memory only | Single-instance only |
| Helm HA configuration | replicas=1, no PDBs | Not production-hardened |
| Application Framework | Not implemented | No UI layer; API-only |
| Federation protocol | Interface defined, not implemented | Single-instance only |
| TypeDB / Neo4j providers | Not implemented | PostgreSQL+AGE only |
| FHIR write operations | Read-only | Mutations via GraphQL/REST |

---

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/open-foundry-spec-v2.md`](docs/open-foundry-spec-v2.md) | Full technical specification (2,744 lines) |
| [`docs/mvp-nhs-pilot.md`](docs/mvp-nhs-pilot.md) | MVP design document (1,036 lines) |
| [`deploy/README.md`](deploy/README.md) | Development deployment quickstart |

---

## How This Was Built

This codebase was authored entirely by **Claude Opus 4.6** (Anthropic) running inside the **Avril** harness — a session-based agent framework for quality-assured code generation at scale. The work was orchestrated by **Cardinal**, a task planning and execution system that decomposed the technical specification into implementable work units, managed dependencies between tasks, and tracked progress across the 48-commit build.

The process:

1. **Specification** — The Open Foundry spec (2,744 lines) and MVP plan (1,036 lines) were written via human-agent collaboration.
2. **Task decomposition** — Cardinal broke the spec into ~120 discrete tasks across 17 packages, ordered by dependency graph.
3. **Implementation** — Opus 4.6, operating in parallel Avril sessions, implemented each task: writing source code, tests, deployment configuration, and documentation.
4. **Review** — A comprehensive code review (168+ findings) was conducted and all CRITICAL and HIGH severity issues were resolved.

### By the Numbers

| Metric | Value |
|--------|-------|
| TypeScript source | ~26,000 lines |
| Test code | ~26,000 lines |
| Go source (CEL evaluator) | ~1,900 lines |
| Domain pack config (ODL, YAML, FGA) | ~500 lines |
| Deployment config | ~1,600 lines |
| Specification + MVP docs | ~3,800 lines |
| Commits | 48 |
| Packages | 17 |
| Unit tests | 1,372+ |
| Human-written lines of code | 0 |

---

## License

Apache 2.0
