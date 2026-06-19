---
title: Architecture Overview
created: 2026-06-18
last_updated: 2026-06-18
type: synthesis
status: active
related_components:
  - spi
  - odl
  - ontology-engine
  - action-executor
  - api-gateway
  - security-service
  - sync-engine
  - storage-postgres
  - cel-evaluator
---

# Architecture Overview

Open Foundry is a **domain-neutral ontology platform** for building operational digital twins. It provides the semantic, kinetic, and security layers needed to turn commodity data infrastructure into a coherent, queryable, actionable model of a real-world system.

## Layered Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Application Framework (planned)            │
│            Widgets, dashboards, app builder                  │
├─────────────────────────────────────────────────────────────┤
│                    Query & API Layer                         │
│        GraphQL ([[api-gateway]]) · REST · FHIR R4 · SDK     │
├─────────────────────────────────────────────────────────────┤
│                    Action Framework                          │
│   [[action-executor]]: validate → authorize → consent       │
│   → CEL preconditions → effects → side-effects → audit      │
├──────────────────────┬──────────────────────────────────────┤
│   Security Layer     │        Sync Engine                    │
│  [[security-service]]: │  [[sync-engine]]: JDBC + Debezium  │
│  OIDC, OpenFGA ReBAC,│  CDC, overlay, conflict resolution   │
│  consent, audit      │                                       │
├──────────────────────┴──────────────────────────────────────┤
│                    Ontology Engine                            │
│    [[ontology-engine]]: schema registry, object store,       │
│    link graph (Apache AGE), validation, versioning           │
├─────────────────────────────────────────────────────────────┤
│               Storage Provider Interface ([[spi]])           │
│    [[storage-memory]] (testing) | [[storage-postgres]]      │
└─────────────────────────────────────────────────────────────┘
```

## Package Dependency Graph

Each layer communicates only with adjacent layers through defined interfaces:

```
odl ─────────────────────────────────────────────────────────────┐
  │  (compiler: ODL → GraphQL API, REST, OpenFGA model, SDK)    │
  ▼                                                              │
spi (core type contracts)                                        │
  ├─ engine (object lifecycle, links, validation)                │
  │    ├─ actions (CEL pipeline, side effects)                   │
  │    └─ security (auth, ReBAC, consent, audit)                 │
  ├─ api (GraphQL Server, REST router, FHIR, subscriptions)      │
  │    └─ consumes: engine, actions, security, sync              │
  ├─ sync (connectors, CDC, mapping, overlay)                    │
  │    └─ consumes: engine                                      │
  ├─ storage-memory (tests + development)                        │
  └─ storage-postgres (production)                                │
cel-evaluator (Go, gRPC) ← consumed by: actions                  │
observability (OTel, pino) ← consumed by: all                    │
sdk-typescript (auto-generated client)                            │
```

## Data Flow: Schema → API → Storage

```
ODL Schema (@objectType, @linkType, @actionType)
  │
  ▼ [[odl]] compiler
Generated: GraphQL SDL, REST routes, OpenFGA model, TS SDK
  │
  ▼ [[api-gateway]] 
Mounted: GraphQL endpoint (Apollo), REST endpoints, FHIR R4, WebSocket
  │
  ▼ Security Layer (every request)
OIDC validation → ReBAC check → consent evaluation → audit trail
  │
  ▼ Object Lifecycle ([[ontology-engine]])
create → validate → store → version → link → traverse
  │
  ▼ [[storage-postgres]]
Dual storage: PostgreSQL (CRUD, FTS) + Apache AGE (graph traversal)
```

## Action Pipeline

Every mutation traverses a mandatory 7-step pipeline via [[action-executor]]:

```
User action → validate → authorize → consent → preconditions (CEL)
  → execute (effects) → side-effects (webhooks, events) → audit → emit (Kafka)
```

Actions are defined declaratively in YAML manifests with CEL expressions for preconditions and effects. The [[cel-evaluator]] Go sidecar evaluates CEL in isolation from the Node.js runtime. See [[adr-005-action-pipeline]] for the rationale.

## Domain Pack Composition

Domain-specific functionality is delivered through composable [[domain-pack-architecture|Domain Packs]]:

| Pack | Namespace | Objects | Links | Actions | Connectors |
|------|-----------|---------|-------|---------|------------|
| [[core-domain-pack\|Core]] | `openfoundry.core` | Interfaces + scalars | — | — | — |
| [[nhs-acute-pilot\|NHS Acute]] | `nhs.acute` | 5 | 6 | 5 | PAS (JDBC) |
| [[aml-domain-pack\|AML]] | `aml` | 6 | 7 | 6 | TMS (JDBC) |
| [[supply-chain-domain-pack\|Supply Chain]] | `supply.chain` | 6 | 7 | 4 | ERP (JDBC) |
| [[osint-domain-pack\|OSINT]] | `osint` | 10 | 35 | 7 | Twitter, ACLED |

## Deployment

The platform deploys as a Docker Compose stack (development) or Helm chart (Kubernetes):

- **13 services**: api-gateway, ontology-engine, action-executor, sync-engine, security-service, cel-evaluator, postgresql+AGE, OpenFGA, Keycloak, Redis, Redpanda/Kafka, Debezium, OTel collector
- **Storage**: PostgreSQL 17 + Apache AGE (graph extension)
- **Event bus**: Redpanda (Kafka-compatible) for CloudEvents
- **Observability**: OpenTelemetry traces + Prometheus metrics + structured JSON logging
- **Governance**: OpenFGA ReBAC, OIDC authentication, consent management, immutable audit trail

## Key Metrics

- **12 packages**, 20 total workspace packages including domain packs and tests
- **172,742 lines** TypeScript source + test code
- **65 test files** across all packages
- **2,040 unit + integration tests** (1,883 unit + 110 PG integration + 47 Docker-stack integration)
- **5 domain packs** (core + 4 domain-specific)

## Sources

- [Source: open-foundry-spec-v2.md] — Full technical specification
- [Source: README.md] — Project overview and getting started
