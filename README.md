# Open Foundry

**An open-source ontology platform for building operational digital twins.**

Open Foundry provides the semantic, kinetic, and security layers needed to turn commodity data infrastructure into a coherent, queryable, actionable model of a real-world system. The platform is domain-neutral — domain-specific functionality is delivered through composable **Domain Packs**.

> **Status:** Active MVP. Core platform is functional with three domain packs. Production-hardening gaps (schema/audit persistence, Helm HA) are documented under [Known Deferrals](#known-deferrals).

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
type Asset @objectType {
  id: ID! @primary
  serialNumber: String @unique @indexed
  name: String!
  status: AssetStatus!
  category: AssetCategory
}

link LocatedAt @linkType(from: "Asset", to: "Facility", cardinality: MANY_TO_ONE)

action TransferAsset @actionType {
  assetId: ID! @param
  facilityId: ID! @param
}
```

**Storage Provider Interface (SPI)** — All persistence goes through a pluggable interface. The platform ships with PostgreSQL+AGE (graph + relational) for production and an in-memory provider for tests. The SPI covers schema management, CRUD, links, queries, aggregation, full-text search, transactions, temporal queries, lineage, and multi-tenancy.

**Action Framework** — Actions are transactional mutations defined in YAML manifests with CEL preconditions and effects. The pipeline runs: validate → authorise → consent → preconditions → execute → audit → emit. A Go gRPC sidecar handles CEL expression evaluation.

**Security** — OIDC authentication, OpenFGA ReBAC for relationship-based access control, field-level redaction, consent management with healthcare-specific direct-care exemptions, and an immutable audit trail.

---

## Domain Packs

Domain Packs are composable schema and configuration modules that specialise the platform for a particular domain. Three are included:

| Pack | Namespace | Object Types | Actions | Connectors |
|------|-----------|-------------|---------|------------|
| **NHS Acute** | `nhs.acute` | Patient, Ward, Bed, Consultant, DischargeRecord | Admit, Discharge, Transfer | PAS (JDBC + CDC) |
| **AML** | `aml` | Customer, Transaction, Alert, Case, Account, SuspiciousActivityReport | AssignAlertToCase, FlagTransaction, FreezeAccount, OpenCase, FileReport, SubmitReport | TMS (JDBC) |
| **Supply Chain** | `supply.chain` | Product, Supplier, Shipment, Facility, InventoryRecord, PurchaseOrder | ShipOrder, ReceiveShipment, CreateOrder, CancelOrder | ERP (JDBC + CDC) |

Each pack includes ODL schemas, action manifests, OpenFGA permission models, and optional sync connectors.

### NHS Acute Pilot

The NHS Acute pack is the most mature vertical slice, targeting patient flow through wards, beds, and consultants at an acute trust. It demonstrates:

- A live ontology modelling patients, wards, beds, and consultants
- Data flowing from a PAS (Patient Administration System) via JDBC/CDC
- Clinicians executing actions (admit, discharge, transfer) through GraphQL
- ReBAC-enforced permissions with ward-scoped visibility
- An immutable audit trail for every operation
- A FHIR R4 read endpoint for interoperability

---

## Packages

The monorepo contains 20 packages across four workspace roots:

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
| `@openfoundry/domain-pack-aml` | `aml` | 8 ODL schemas, 6 actions, 1 connector, permissions |
| `@openfoundry/domain-pack-supply-chain` | `supply.chain` | 8 ODL schemas, 4 actions, 1 connector, permissions |

### Tests (`tests/`)

| Package | Purpose |
|---------|---------|
| `@openfoundry/spi-conformance` | Reusable SPI conformance suite (287 tests, 10 categories) |
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
- Go 1.24+ (only when building `packages/cel-evaluator` outside Docker)

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

This starts 12 services: PostgreSQL+AGE, RedPanda (Kafka), Debezium CDC, Keycloak (OIDC), OpenFGA (ReBAC), OpenTelemetry Collector, api-gateway, ontology-engine, action-executor, sync-engine, security-service, and cel-evaluator. See [`deploy/README.md`](deploy/README.md) for the full service table.

### Try the API

Once the stack is running:

- **GraphQL Playground:** http://localhost:4000/graphql
- **REST API:** http://localhost:4000/api/v1/
- **FHIR R4:** http://localhost:4000/fhir/

### Kubernetes Deployment

A Helm chart is provided for single-replica evaluation deployments. HA production settings are deferred (see [Known Deferrals](#known-deferrals)).

```bash
helm install openfoundry deploy/helm/openfoundry \
  --namespace openfoundry \
  --create-namespace
```

---

## Test Coverage

1,780+ unit and integration tests across all packages.

Database-backed integration tests are skipped unless the required Docker/PostgreSQL services are available.

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
| [`docs/open-foundry-spec-v2.md`](docs/open-foundry-spec-v2.md) | Full technical specification |
| [`docs/mvp-nhs-pilot.md`](docs/mvp-nhs-pilot.md) | MVP design document |
| [`deploy/README.md`](deploy/README.md) | Development deployment quickstart |

---

## How This Was Built

Open Foundry was built in two phases — an automated scaffold phase followed by human-agent collaboration for expansion and hardening.

### Phase 1: Cardinal (commits `0a3d5ff`–`b01ca90`)

Cardinal, a task planning and execution system, decomposed the technical specification into ~120 discrete tasks across 20 packages, ordered by dependency graph. Claude Opus 4.6, operating in parallel Avril sessions, implemented each task autonomously: source code, tests, deployment configuration, and documentation. Cardinal managed dependencies between tasks, tracked progress, and ran 8 automated review passes to resolve consistency and type-safety issues. This phase produced the core platform, NHS Acute domain pack, deployment stack, and initial test suite across 48 commits.

### Phase 2: Human-Agent Collaboration (commits `87054f3`–present)

A human engineer took over direction — reviewing the codebase, revising the specification, expanding domain coverage, and driving iterative hardening. Work in this phase includes:

- **Spec refinement** — Three rounds of spec review addressing gaps in directives, resilience, lifecycle, and federation contracts.
- **Domain expansion** — Two new domain packs (AML, Supply Chain) with full schemas, actions, connectors, and permission models.
- **Feature additions** — Aggregation queries, full-text search, object sets, and connector plugin architecture.
- **Security hardening** — Multiple review rounds (including cross-model Codex reviews) identified and fixed 200+ issues across auth pipelines, SQL injection, field-level redaction, system-field mapping, and error handling.
- **Regression test suite** — Targeted tests covering the most critical bugs found during review.

### By the Numbers

| Metric | Value |
|--------|-------|
| TypeScript source | ~24,000 lines |
| Test code | ~29,000 lines |
| Go source (CEL evaluator) | ~1,900 lines |
| Domain pack config (ODL, YAML, FGA) | ~1,700 lines |
| Deployment config | ~2,000 lines |
| Specification + MVP docs | ~4,200 lines |
| Packages | 20 |
| Unit tests | 1,780+ |

---

## License

Apache 2.0
