---
title: API Gateway
created: 2026-06-18
last_updated: 2026-06-18
type: component
package: "@openfoundry/api"
status: active
related_components:
  - spi
  - odl
  - ontology-engine
  - action-executor
  - security-service
  - sync-engine
  - ner-extraction
  - security-service
  - storage-memory
  - storage-postgres
  - sync-engine
  - observability-library
---

# API Gateway

The `@openfoundry/api` package is the **entry point for all external interaction** with the Open Foundry platform. It provides a unified API surface — GraphQL, REST, and FHIR R4 — all auto-generated from the ODL schema. It also enforces governance: rate limiting, query complexity analysis, execution timeouts, response size limits, WebSocket subscription management, and spec artifact generation (OpenAPI 3.0.3, GraphQL SDL, AsyncAPI 2.6.0). It composes all lower layers ([[ontology-engine]], [[action-executor]], [[security-service]], [[sync-engine]]) into a single runnable server.

## Public API

**GraphQL Server:**
- `createGraphQLServer(config)` → `GraphQLServerInstance` — Boots an Apollo Server 4 with auto-generated resolvers from ODL schema. Returns a fully configured Express app with GraphQL, REST, and FHIR middleware.
- `generateResolvers(schema, deps)` — Auto-generates typed resolvers for all object types, link traversals, computed fields, search, aggregates, and mutations.
- `buildResolverContext(deps)` — Builds the per-request context (authenticated user, tenant, tracer, SPI, security layer).
- `createOpenFoundryError(code, message, details?)`, `wrapError(err)` — Unified error formatting per Spec Section 8.8.
- `encodeCursor(val)`, `decodeCursor(val)` — Relay-style opaque cursor pagination.
- `resolvePagination(args)`, `buildConnection(edges, totalCount, args)` — Relay Connection pagination helpers.
- Types: `GraphQLServerConfig`, `GraphQLServerInstance`, `ApiDependencies`, `ResolverContext`, `AuthenticatedUserInfo`, `PaginationArgs`, `Connection`, `Edge`, `PageInfo`.

**WebSocket Subscriptions:**
- `SubscriptionManager` — Manages graphql-ws subscriptions with per-connection limits (50 max). Handles connection authentication and authorization.
- `InMemorySubscribableEventBus` — In-memory pub/sub for subscription event delivery.
- `createIdFilteredSubscription`, `createFilteredSubscription` — Filter subscription events by object ID or custom predicates.
- `mapObjectEvent`, `mapLinkEvent` — Map internal CloudEvents to subscription payloads.
- Types: `ChangeEvent`, `SubscriptionFilter`, `ConnectionAuthResult`, `ConnectionAuthenticator`, `SubscribableEventBus`, `SubscriptionManagerConfig`.

**Governance:**
- `SlidingWindowRateLimiter` — Four-tier rate limiting: IP (300/min), tenant (1000/min), principal (200/min), client app (500/min). Redis-backed when `REDIS_URL` is set; in-memory fallback otherwise.
- `QueryComplexityAnalyzer` — Rejects expensive queries before execution (configurable depth, breadth, cost).
- `withTimeout(promise, ms)`, `checkResponseSize(size, limit)` — Execution guards.
- `createTimeoutError()`, `createResponseTooLargeError()` — Standardized error factories.
- `DEFAULT_EXECUTION_GUARD_CONFIG` — Depth 10, breadth 50, cost 1000 defaults.
- Types: `RateLimitConfig`, `RateLimitWindow`, `RateLimitIdentity`, `RateLimitResult`, `ComplexityConfig`, `ComplexityAnalysis`, `ExecutionGuardConfig`.

**FHIR R4:**
- `createFhirRouter(config)` → Express router — Read-only FHIR R4 endpoints (`GET /fhir/Patient`, `GET /fhir/Encounter`, `GET /fhir/metadata`).
- `buildPatientFilter(query)`, `mapPatientToFhir(obj)`, `mapEncounterToFhir(obj)` — FHIR-to-ontology mapping helpers.
- Constants: `NHS_NUMBER_SYSTEM`, `NHS_PATIENT_PROFILE`, `NHS_ENCOUNTER_PROFILE`.
- Types: Full FHIR R4 resource types (`FhirPatient`, `FhirEncounter`, `FhirBundle`, `FhirOperationOutcome`, etc.).

**REST API:**
- `generateRestRoutes(schema, deps)` → `RestRoute[]` — Auto-generates REST endpoints per object type (list, get, `/links`, `/history`, `/aggregate`) and governed actions via `POST /api/v1/actions/{Name}`.
- `mapErrorToHttpStatus(err)`, `createRestErrorResponse(err)`, `wrapErrorToRest(err)` — Consistent REST error handling.
- Types: `RestRequest`, `RestResponse`, `RestRoute`.

**CDM Projection (FDP):**
- Read-only CDM view mapping the operational ontology to an NHS FDP Canonical Data Model shape (`/api/v1/cdm/*` and GraphQL `cdmMetadata`/`cdmRecord`/`cdmRecords`/`cdmEncounters`), with provenance preserved per record and a published gap register.

**API Contract Artifacts:**
- `spec:openapi` — Dumps OpenAPI 3.0.3 spec.
- `spec:graphql` — Dumps GraphQL SDL.
- `spec:asyncapi` — Dumps AsyncAPI 2.6.0 spec.
- `spec:all` — Dumps all three.

## Dependencies

- **External (11):** `@apollo/server`, `@graphql-tools/schema`, `@openfga/sdk`, `cors`, `express`, `graphql`, `graphql-subscriptions`, `graphql-ws`, `helmet`, `ioredis`, `kafkajs`, `pino`, `prom-client`, `ws`, `yaml`.
- **Internal (8):** `@openfoundry/actions`, `@openfoundry/engine`, `@openfoundry/observability`, `@openfoundry/odl`, `@openfoundry/security`, `@openfoundry/spi`, `@openfoundry/storage-memory`, `@openfoundry/storage-postgres`, `@openfoundry/sync`.

## Used By

- External clients (web apps, Nightingale reference app, REST/GraphQL consumers).
- The SDK (`@openfoundry/sdk`) consumes the GraphQL/REST endpoints this package serves.
- Deployment artifacts (`deploy/`) configure and run this as the main application container.

## Key Design Decisions

- **Single server, three protocols** — GraphQL, REST, and FHIR share one Express process. This avoids the complexity and latency of a federation gateway for the initial deployment, while still supporting protocol-specific governance.
- **Auto-generated everything** — All resolvers, REST routes, and endpoint structures are generated from ODL schema via [[odl]]. Handwritten code is limited to governance middleware (rate limiting, complexity analysis, auth) and protocol-specific adapters (FHIR mapping, REST error formatting).
- **Introspection disabled in production** — Schema exploration is only available in development mode to prevent information disclosure.
- **Connection-level governance** — Per-connection limits on WebSocket subscriptions (50 max) prevent resource exhaustion from malicious or buggy clients.

## Test Coverage

- **17 test files**: `graphql.test.ts`, `rest.test.ts`, `fhir.test.ts`, `cdm.test.ts`, `subscriptions.test.ts`, `governance.test.ts`, `redis-rate-limiter.test.ts`, `redpanda-event-bus.test.ts`, `consent-pagination.test.ts`, `schema-loader.test.ts`, `schema-registry-boot.test.ts`, `filter-mapping-regression.test.ts`, `cursor-regression.test.ts`, `openapi.test.ts`, `asyncapi.test.ts`, `spec-roundtrip.test.ts`, `fga-dsl-to-json.test.ts`.

## Sources

- [Source: open-foundry-spec-v2.md Section 8 — Query and API Layer]
- [Source: open-foundry-spec-v2.md Section 8.1 — Auto-Generated GraphQL API]
- [Source: open-foundry-spec-v2.md Section 8.2 — REST API]
- [Source: open-foundry-spec-v2.md Section 8.3 — FHIR R4 API]
- [Source: open-foundry-spec-v2.md Section 8.4 — Client SDKs]
- [Source: open-foundry-spec-v2.md Section 8.7 — API Governance and Quotas]
- [Source: open-foundry-spec-v2.md Section 8.8 — Unified Error Model]
- [Source: open-foundry-spec-v2.md Section 8.9 — API Versioning Strategy]
