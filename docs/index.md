---
title: Project Index
created: 2026-06-18
last_updated: 2026-06-18
type: index
status: active
---

# OpenFoundry — Project Index

## Components

- [[spi]] — Core type contracts and interfaces. _(package: @openfoundry/spi)_
- [[odl]] — Ontology Definition Language compiler (GraphQL SDL + directives). _(package: @openfoundry/odl)_
- [[ontology-engine]] — Object lifecycle, link management, validation, versioning. _(package: @openfoundry/engine)_
- [[action-executor]] — Action pipeline: validate → authorize → consent → execute → side-effects → audit. _(package: @openfoundry/actions)_
- [[api-gateway]] — GraphQL (Apollo), REST, FHIR R4, WebSocket server. _(package: @openfoundry/api)_
- [[security-service]] — OIDC authentication, OpenFGA ReBAC, consent management, audit trail. _(package: @openfoundry/security)_
- [[storage-memory]] — In-memory SPI implementation for tests and development. _(package: @openfoundry/storage-memory)_
- [[storage-postgres]] — PostgreSQL 17 + Apache AGE SPI for production. _(package: @openfoundry/storage-postgres)_
- [[sync-engine]] — Connectors, CDC, mapping, overlay, conflict resolution, entity extraction. _(package: @openfoundry/sync)_
- [[ner-extraction]] — NER pipeline: compromise-based Person/Org/Location extraction + equipment gazetteer. _(package: @openfoundry/sync)_
- [[ner-service]] — Python gRPC sidecar: three-stage NER (GLiNER + Flair + phi4-mini). _(package: @openfoundry/ner-service)_
- [[observability-library]] — OpenTelemetry traces, Prometheus metrics, structured logging (pino). _(package: @openfoundry/observability)_
- [[sdk-typescript]] — Auto-generated TypeScript client from ODL schema. _(package: @openfoundry/sdk)_
- [[cel-evaluator]] — Go gRPC sidecar for CEL expression evaluation. _(package: cel-evaluator)_
- [[twitter-connector]] — X.com GraphQL API connector with browser cookie auth and auto endpoint discovery. _(package: @openfoundry/sync)_

## Features & Domain Packs

- [[nhs-acute-pilot]] — NHS acute healthcare: patient flow, bed management, ReBAC-governed clinician actions. _(status: active)_
- [[aml-domain-pack]] — Anti-money laundering: transaction monitoring, alert triage, SAR filing. _(status: active)_
- [[supply-chain-domain-pack]] — Supply chain: orders, shipments, inventory across facilities. _(status: active)_
- [[osint-domain-pack]] — Geopolitical OSINT: IntelReport, SourceProfile, 10 entity types, 35 links, 7 actions, Twitter connector live, NER pipeline active. _(status: in-progress)_
- [[fdp-cdm-integration]] — FDP/CDM compatibility layer: NHS data model projection with provenance. _(status: in-progress)_
- [[ner-entity-extraction-plan]] — Plan for NER pipeline — implemented 2026-06-18. _(status: in-progress)_
- [[ner-approach-specification]] — Comprehensive research: 4 NER approaches compared, hybrid architecture recommended. _(status: draft)_
- [[ner-python-vs-typescript-comparison]] — Python vs TypeScript/JS NER ecosystem comparison — Python dramatically superior. _(status: draft)_
- [[ner-three-stage-pipeline-spec]] — Three-stage NER: parallel GLiNER + Flair + LLM verification. _(status: draft)_
- [[ner-three-stage-pipeline-plan]] — Implementation plan: 15 tasks, 4 phases, 22 files. Python gRPC sidecar. _(status: in-progress)_

## Architecture Decisions

- [[adr-001-odl-as-graphql-sdl]] — ODL extends GraphQL SDL with semantic directives instead of a custom DSL. _(date: 2026-06-18)_
- [[adr-002-cel-go-sidecar]] — CEL evaluation runs in Go gRPC sidecar, not TypeScript. _(date: 2026-06-18)_
- [[adr-003-rebac-via-openfga]] — ReBAC via OpenFGA (Google Zanzibar) instead of static RBAC. _(date: 2026-06-18)_
- [[adr-004-spi-storage-abstraction]] — Storage-agnostic SPI with pluggable providers (PostgreSQL+AGE, in-memory). _(date: 2026-06-18)_
- [[adr-005-action-pipeline]] — Mandatory 7-step action pipeline. _(date: 2026-06-18)_
- [[adr-006-overlay-mode]] — Overlay mode (read-through mapping) for phased rollout. _(date: 2026-06-18)_
- [[adr-007-monorepo-turborepo]] — pnpm + Turborepo monorepo with four workspace roots. _(date: 2026-06-18)_
- [[adr-008-two-phase-build]] — Automated scaffold (Cardinal) + human-agent collaboration. _(date: 2026-06-18)_
- [[adr-009-twitter-internal-api]] — Why use Twitter's internal GraphQL API vs official X API v2. _(date: 2026-06-17)_
- [[adr-010-osint-schema-design]] — OSINT domain pack 10-type entity model design decisions. _(date: 2026-06-17)_
- [[adr-011-ner-compromise-over-wink]] — Compromise library selected for NER instead of wink-nlp (lite model lacks NER classification). _(date: 2026-06-18)_
- [[adr-012-ner-python-sidecar]] — Python gRPC sidecar for three-stage NER pipeline (GLiNER + Flair + phi4-mini). _(date: 2026-06-18)_

## Concepts

- [[odl-schema-driven]] — ODL as single source of truth: schema → GraphQL API, REST, OpenFGA model, TypeScript SDK.
- [[rebec-authorization]] — Relationship-Based Access Control and how OpenFGA implements it with auto-generated models from ODL.
- [[cel-expressions]] — CEL (Common Expression Language) for action preconditions, effects, constraints, and migration transforms.
- [[cdc-sync-pattern]] — Change Data Capture via Debezium for real-time external system synchronization.
- [[domain-pack-architecture]] — How domain packs compose ODL schemas, action manifests, permissions, connectors, and functions.
- [[connector-pattern]] — Connector plugin architecture: interface contract, reference connectors, datasource bindings.
- [[action-orientation]] — Objects mutated only through governed actions; no generic CRUD.
- [[federation-first]] — Multi-instance, multi-tenant design with Data Sharing Agreements, cross-instance queries.

## Syntheses

- [[architecture-overview]] — High-level architecture: layered design, package dependency graph, data flow, domain packs, deployment topology.
- [[integration-flow]] — External system integration: connector lifecycle, sync modes, mapping transforms, conflict resolution, backpressure.
- [[security-architecture]] — End-to-end security: OIDC → ReBAC → consent → audit, action pipeline security, container hardening.

## Vision

- [[vision]] — Product vision: open-source geopolitical OSINT platform, target users, core differentiators, intelligence cycle, development phases.

## Meta

- Total components: 15
- Total features: 9
- Total decisions: 12
- Total concepts: 8
- Total syntheses: 3
- Total pages: 42
