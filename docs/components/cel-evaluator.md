---
title: CEL Evaluator (Go gRPC Sidecar)
created: 2026-06-18
last_updated: 2026-06-18
type: component
package: "cel-evaluator (Go, not an npm package)"
status: active
related_components:
  - action-executor
  - api-gateway
---

# CEL Evaluator (Go gRPC Sidecar)

The CEL Evaluator is a **Go gRPC sidecar service** that provides the canonical CEL (Common Expression Language) runtime for the Open Foundry platform. Per Spec Section 5.2.4, all CEL expression evaluation MUST use a canonical evaluator — this Go sidecar is that evaluator. It runs as a separate process (not in-process TypeScript), exposed via gRPC on port 50051, and evaluated by the `CelClient` in [[action-executor]]. The Go implementation uses Google's `cel-go` library, which is the reference implementation of CEL and provides compile-time type-checking, microsecond-scale evaluation, and guaranteed termination (no loops, no I/O, no side-effects).

## Public API

**gRPC Service** (`cel.CelEvaluator`, defined in `proto/cel_service.proto`):

- **`Evaluate(EvalRequest)` → `EvalResponse`** — Evaluates a single CEL expression against provided variables and optional type environment. Returns the result as a protobuf `Value` or an error string.
  - Input: `expression` (string), `variables` (map of protobuf Values), `typeEnv` (optional type declarations).
  - Output: `result` (protobuf Value) or `error` (string, non-nil on evaluation failure).

- **`EvaluateBatch(BatchEvalRequest)` → `BatchEvalResponse`** — Evaluates multiple CEL expressions in a single gRPC call, sharing the compiled environment across all expressions for efficiency.
  - Input: `expressions` (array of strings), `variables`, `typeEnv`.
  - Output: `results` (array of strings, each a JSON-serialized result).

**gRPC Health Check:**
- Standard gRPC health service (`grpc.health.v1.Health`) on the same port. Reports `SERVING` during normal operation, `NOT_SERVING` during graceful shutdown.

**Server Configuration:**
- `CEL_PORT` environment variable — gRPC listen port (default: `50051`).
- `GIT_REVISION` environment variable — Revision string logged at startup (truncated to 8 chars).

**Graceful Shutdown:**
- Handles `SIGINT`/`SIGTERM` — sets health status to `NOT_SERVING`, then calls `GracefulStop()` on the gRPC server to drain in-flight requests before terminating.

## Implementation Details

**Go Module:** `github.com/openfoundry/cel-evaluator` (Go 1.24+)

**Key Go packages:**
- `google.golang.org/grpc` — gRPC server framework.
- `google.golang.org/protobuf` — Protocol Buffers (proto3) for message serialization.
- `github.com/google/cel-go` — Google's CEL reference implementation: parser, type-checker, and evaluator.
- `github.com/santhosh-tekuri/jsonschema/v6` — JSON Schema validation for variable schemas.
- `google.golang.org/grpc/health` — gRPC health check protocol.

**Source layout:**
- `main.go` — Server entry point, gRPC setup, graceful shutdown.
- `evaluator/` — CEL evaluator wrapper (`evaluator.go`, `evaluator_test.go`).
- `proto/` — Protobuf service definition (`cel_service.proto`).
- `Dockerfile` — Multi-stage Docker build (Go builder → distroless runtime).

**Supported CEL features:**
- Variables: `params`, `actor`, `now` (per spec environment).
- Functions: `actor.hasRole(role)`, `actor.hasPermission(perm, resource)`, `has_link(object, linkType)`, `count_links(object, linkType)`, `duration(iso8601)`.
- Duration arithmetic: `now + duration('PT2H')` for timestamp math.
- Type declarations: strongly-typed variables with compile-time type checking.
- JSON Schema support: variable schemas can be validated against JSON Schema definitions.

## Dependencies

All Go dependencies, no Node.js dependencies:
- **`github.com/google/cel-go`** (v0.27.0) — CEL language implementation.
- **`github.com/santhosh-tekuri/jsonschema/v6`** (v6.0.2) — JSON Schema validation.
- **`google.golang.org/grpc`** (v1.79.3) — gRPC framework.
- **`google.golang.org/protobuf`** (v1.36.11) — Protocol Buffers runtime.
- Indirect: `cel.dev/expr`, `antlr4-go`, `golang.org/x/exp`, `golang.org/x/net`, `golang.org/x/sys`, `golang.org/x/text`, Google API protos.

## Used By

- [[action-executor]] — `CelClient` gRPC client connects to this sidecar to evaluate preconditions, effect conditions, and actor role checks during the action execution pipeline.
- [[api-gateway]] (indirectly) — All action mutations that require CEL precondition evaluation transitively depend on this service being available.

## Key Design Decisions

- **Go sidecar over in-process TypeScript** — CEL's reference implementation is in Go (`cel-go`). Running it in-process would require either a WASM build (immature, slow) or a Node.js-native CEL implementation (non-canonical, risks behavioral divergence). The gRPC sidecar pattern provides: (1) canonical CEL behavior, (2) process isolation (CEL panics don't crash Node.js), (3) independent scaling, (4) the option to use the same evaluator from non-Node.js clients in the future.
- **gRPC over REST/HTTP** — gRPC was chosen for the sidecar interface because: (1) protobuf serializer handles the complex nested value types CEL produces, (2) the low-latency binary protocol matters for microsecond-scale CEL evaluation, (3) gRPC health checks integrate with Kubernetes readiness probes.
- **Distroless runtime** — The Dockerfile uses a Google distroless base image (`gcr.io/distroless/static-debian12:nonroot`) for the runtime stage, providing a minimal attack surface with no shell, no package manager, and read-only root filesystem.

## Test Coverage

- **1 test file** (Go): `evaluator/evaluator_test.go` — Tests CEL expression evaluation, type checking, batch evaluation, error handling, and JSON Schema validation.

## Sources

- [Source: open-foundry-spec-v2.md Section 5.2 — Expression Language (CEL)]
- [Source: open-foundry-spec-v2.md Section 5.2.1 — CEL Environment (variables and functions)]
- [Source: open-foundry-spec-v2.md Section 5.2.4 — Canonical Evaluator requirement]
