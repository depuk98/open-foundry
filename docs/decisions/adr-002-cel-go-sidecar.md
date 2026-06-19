---
title: ADR-002 — CEL Evaluation Runs in Go gRPC Sidecar, Not TypeScript
created: 2026-06-18
last_updated: 2026-06-18
type: decision
status: accepted
related_components:
  - cel-evaluator
  - actions
  - odl-compiler
---

# ADR-002: CEL Evaluation Runs in Go gRPC Sidecar, Not TypeScript

## Context

The Action Framework uses CEL (Common Expression Language) for action preconditions, effect expressions, field-level `@constraint` validation, and data migration transforms. CEL is a Google-authored language with formal grammar, type-checking at compile time, microsecond-scale evaluation, and guaranteed termination (no loops, no I/O, no side-effects). The platform core is implemented in TypeScript, but CEL's reference implementations are in Go, Java, and C++. We had to choose a runtime strategy for evaluating CEL expressions in a TypeScript-based platform.

## Decision

**CEL evaluation runs in a dedicated Go gRPC sidecar service (`cel-evaluator`), not in the TypeScript runtime.** The TypeScript action executor communicates with the Go sidecar via a gRPC contract. Preconditions, effects, constraints, and migration expressions are all evaluated by the same canonical engine. The gRPC contract includes deterministic test vectors to verify parity across compilation and execution.

This decision is explicitly called out in the specification: "CEL evaluation MUST use a canonical evaluator with compatibility guarantees. Pure TypeScript CEL implementations MAY be used only for tooling/linting, not as authoritative runtime evaluators."

The sidecar receives the CEL expression, the variable environment (ODL-typed objects, params, actor, now), and returns the evaluated result. The TypeScript layer is responsible for assembling the environment — resolving ODL objects and links — but the Go sidecar owns expression evaluation.

## Alternatives Considered

- **Pure TypeScript CEL** — A JavaScript/TypeScript port of the CEL evaluator. Rejected because: no canonical TypeScript implementation exists, maintaining spec parity with the Google reference implementation would be a perpetual maintenance burden, and subtle evaluation differences could cause security-critical precondition failures (false positives or false negatives). The spec explicitly prohibits this as the authoritative runtime.
- **WASM-compiled CEL** — Compile the Go CEL engine to WASM and embed it in the Node.js process. Listed in the spec as the "preferred" long-term option. Rejected for v1 because: the WASM build pipeline is immature, cross-runtime debugging is harder, and the gRPC sidecar provides a cleaner contract boundary. WASM remains the preferred future direction once the toolchain stabilizes.
- **Java sidecar via JNI or gRPC** — Use the Java CEL implementation. Rejected because: Java runtime adds significantly more operational overhead than Go (memory footprint, startup time), and Go's is the most mature CEL implementation with the strongest type-system integration for `google.protobuf.Timestamp` and `google.protobuf.Duration`.

## Consequences

### What becomes easier

- **Deterministic, canonical evaluation** — Every CEL expression, whether in preconditions, constraints, or migrations, evaluates identically to Google's reference implementation. The Go `cel-go` library is maintained by the CEL project authors.
- **Type safety at compilation time** — The ODL compiler maps ODL types to CEL types (`String` → `string`, `DateTime` → `google.protobuf.Timestamp`, etc.) and type-checks all expressions at schema compile time. This catches type errors before deployment. See [[cel-expressions]].
- **Clean separation of concerns** — The TypeScript platform handles orchestration, API serving, and object lifecycle. The Go sidecar handles expression evaluation. The gRPC contract enforces a strict boundary. Each service can be versioned and deployed independently.
- **Microsecond performance** — CEL evaluation in Go is fast enough to run hundreds of precondition checks per action without becoming a bottleneck. The spec targets < 500ms p99 for action execution including 2 side-effects.
- **Future WASM path** — The gRPC contract is deliberately thin. If/when WASM-compiled CEL matures, the sidecar can be replaced with an in-process WASM engine using the same contract interface.

### What becomes harder

- **Deployment complexity** — The platform now requires two runtimes (Node.js + Go) and a gRPC connection between them. The `cel-evaluator` service must be deployed alongside every API/action pod. Non-root containers, health checks, and graceful shutdown must be coordinated across both processes.
- **gRPC operational overhead** — Every action execution adds a gRPC round-trip for each CEL expression. While CEL evaluation itself is microsecond-scale, network latency adds overhead. In practice, the sidecar runs on localhost within the same pod, keeping latency minimal.
- **Debugging across runtime boundaries** — Tracing a CEL evaluation failure requires correlating TypeScript traces (action execution span) with Go traces (CEL evaluation span). OpenTelemetry context propagation across gRPC bridges this gap. See [[observability]].

## Sources

- [Source: open-foundry-spec-v2.md Section 5.2 — Expression Language]
- [Source: open-foundry-spec-v2.md Section 5.2.4 — CEL Runtime Strategy]
- [Source: README.md — Packages: cel-evaluator]
- [Source: README.md — By the Numbers: Go source ~2,100 lines]

## Related

- [[cel-expressions]] — Concept page on CEL for action preconditions and effects
- [[adr-005-action-pipeline]] — How CEL fits into the mandatory 7-step pipeline
- [[actions]] — The Action Framework package that consumes the CEL evaluator
