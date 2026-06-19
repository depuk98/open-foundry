---
title: Action Executor
created: 2026-06-18
last_updated: 2026-06-18
type: component
package: "@openfoundry/actions"
status: active
related_components:
  - spi
  - odl
  - ontology-engine
  - api-gateway
  - security-service
  - cel-evaluator
  - observability-library
  - storage-memory
---

# Action Executor

The `@openfoundry/actions` package is the **kinetic layer** of the Open Foundry platform. It provides the CEL (Common Expression Language) evaluation client, action manifest parser, and action execution pipeline that transforms validated action requests into governed mutations. All data modifications in Open Foundry flow through the action pipeline: validate → authorize → consent → preconditions → execute → side-effects → audit → emit. No data mutation MAY bypass this pipeline.

## Public API

**CEL Integration:**
- `CelClient` — gRPC client that connects to the [[cel-evaluator]] Go sidecar for CEL expression evaluation. Serializes TypeScript values to protobuf, sends `EvalRequest`/`BatchEvalRequest`, and deserializes `EvalResponse`/`BatchEvalResponse`.
- `toProtobufValue(value)`, `fromProtobufValue(pb)` — TypeScript ↔ Protobuf value conversion.
- `serializeObjectVariables(obj)`, `serializeVariables(params, actor, now)` — Prepares variable environments for CEL evaluation.
- Types: `CelClientOptions`, `CelResult`, `TypeEnv`, `TypeEntry`, `EvalRequest`, `BatchEvalRequest`, `BatchEvalResult`, `ProtobufValue`.

**Action Manifest Parser:**
- `parseActionManifest(yamlString)` → `ManifestValidationResult` — Parses YAML action manifests (preconditions, effects, side-effects, rollback config). Returns parsed `ActionManifest` plus validation issues.
- Types: `ActionManifest`, `ActionEffect`, `UpdateObjectEffect`, `CreateLinkEffect`, `DeleteLinkEffect`, `CreateObjectEffect`, `Precondition`, `SideEffect`, `RollbackConfig`, `RollbackPolicy`, `UndoConfig`, `UndoOverride`.

**Action Executor:**
- `ActionExecutor` — The core execution engine. Orchestrates the full pipeline: validates input, evaluates CEL preconditions (via [[cel-evaluator]]), executes effects (object creates/updates, link creates/deletes) within an SPI transaction, applies `ROLLBACK_ALL` compensating strategy on failure, triggers side-effects (HTTP webhooks, event bus), and writes audit records.
- Types: `ActionActor`, `ActionContext`, `ActionResult`, `ActionError`, `AffectedObject`, `ChangeType`, `ActionExecutorConfig`, `SecurityLayer`, `PermissionResult`, `CelEvaluator` (interface), `CelEvalResult`, `SideEffectHandler`, `SideEffectResult`, `AuditWriter`, `ActionEventPublisher`, `RelationshipWriter`, `LinkTupleMap`.

**Side-Effect Executor:**
- `SideEffectExecutor` — Executes HTTP webhooks and publishes CloudEvents post-commit. Integrates with [[api-gateway]]'s event bus (Redpanda/Kafka in production, in-memory in dev).
- Types: `WebhookConfig`, `CloudEventConfig`, `EventBus`, `HttpClient`, `HttpResponse`, `SideEffectExecutionResult`, `SideEffectExecutorConfig`.

**Tool Registry (AI-Ready):**
- `ToolRegistry` — Registers and manages AI-accessible tools (Section 5.7). Supports tool filtering, policy guards, and risk-level classification.
- Types: `ToolRegistryConfig`, `ToolDescriptor`, `ToolKind`, `ToolFilter`, `JsonSchema`, `AgentContext`, `AgentExecutionResult`, `PolicyGuard`, `PolicyGuardResult`, `RiskLevel`.

## Dependencies

- **`@grpc/grpc-js`**, **`@grpc/proto-loader`** — gRPC client for [[cel-evaluator]] communication.
- **`@openfoundry/odl`** — Schema definitions for action type resolution.
- **`@openfoundry/spi`** — `StorageProvider`, `BulkMutationRequest`, `Transaction` types.
- **`@openfoundry/observability`** — Tracing and logging.
- **`yaml`** — YAML manifest parsing.

Dev dependencies: `@openfoundry/storage-memory` (test SPI backend).

## Used By

- [[api-gateway]] — GraphQL mutations and REST `POST /api/v1/actions/{Name}` route into the `ActionExecutor`.

## Key Design Decisions

- **Mandatory pipeline** — Every action goes through validate → authorize → consent → preconditions → execute → side-effects → audit → emit. No step can be skipped. The pipeline enforces governance by design.
- **CEL over custom DSL** — CEL (Google's Common Expression Language) was chosen for preconditions and effects because it is well-specified with formal grammar, type-checked at compile time, microsecond-fast evaluation, and safe by design (no loops, no I/O, guaranteed termination). The [[cel-evaluator]] Go sidecar provides a canonical, isolated CEL runtime.
- **`ROLLBACK_ALL` compensating transactions** — If any effect fails, prior effects within the same action are rolled back using compensating operations, restoring pre-action object and link state. This provides atomicity across multiple object/link operations.
- **Go sidecar for CEL** — The CEL evaluator runs as a separate Go process (not in-process TypeScript) for three reasons: CEL's canonical implementation is in Go, process isolation prevents CEL panics from crashing the Node.js runtime, and the gRPC interface enables independent scaling.

## Test Coverage

- **5 test files**: `client.test.ts` (CEL client), `parser.test.ts` (manifest parser), `action-executor.test.ts` (execution pipeline), `side-effect-executor.test.ts` (webhooks/events), `tool-registry.test.ts` (tool registry).

## Sources

- [Source: open-foundry-spec-v2.md Section 5 — Action Framework]
- [Source: open-foundry-spec-v2.md Section 5.1 — Action Manifest]
- [Source: open-foundry-spec-v2.md Section 5.2 — Expression Language (CEL)]
- [Source: open-foundry-spec-v2.md Section 5.3 — Execution Pipeline]
- [Source: open-foundry-spec-v2.md Section 5.4 — Action API]
- [Source: open-foundry-spec-v2.md Section 5.7 — AI-Ready Action Envelope]
