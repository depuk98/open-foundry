---
title: Observability Library
created: 2026-06-18
last_updated: 2026-06-18
type: component
package: "@openfoundry/observability"
status: active
related_components:
  - ontology-engine
  - action-executor
  - api-gateway
  - security-service
  - storage-postgres
  - sync-engine
---

# Observability Library

The `@openfoundry/observability` package provides **shared OpenTelemetry instrumentation and structured logging** for all Open Foundry platform packages. It is a cross-cutting library: every package that emits traces or structured logs uses the utilities exported here. The library wraps the OpenTelemetry SDK, pino structured logger, and provides consistent context propagation across asynchronous boundaries. Instrumentation is specified alongside interfaces, not added after the fact.

## Public API

**Tracing:**
- `getTracer(name, version?)` — Returns an OpenTelemetry `Tracer` scoped to a component.
- `withSpan(name, fn, attributes?)` — Wraps an async operation in a span, auto-records status and error details.
- `getActiveSpan()` — Returns the current active span from async context.
- `SpanAttributes` — Enum of standardized span attribute keys used across all packages.
- Types: `FoundryLayer` (SPI, ENGINE, ACTIONS, API, SECURITY, SYNC), `OpenFoundrySpanAttributes`.

**Metrics:**
- `createFoundryMetrics()` → `FoundryMetrics` — Creates and registers Prometheus metrics: request duration histogram (`http_request_duration_ms`), throughput counter, storage health gauges.
- `registerSyncLagGauge(syncName)` — Registers a Prometheus gauge for sync lag tracking.
- `MetricNames` — Enum of standardized metric names.
- Types: `MetricName`, `FoundryMetrics`.

**SDK Lifecycle:**
- `initTelemetry(config)` — Initializes the OpenTelemetry SDK: configures OTLP HTTP trace exporter, resource attributes (service name, version), and span processors. Should be called once at application start, before any tracing.
- `shutdownTelemetry()` — Gracefully flushes pending spans and shuts down the SDK. Called during graceful shutdown.

**Structured Logging:**
- `createLogger(name, config?)` — Creates a pino logger instance with JSON output. Logs include trace ID and span ID for correlation. Human-readable (pino-pretty) in development; machine-parseable (JSON) in production.
- All log messages inherit request trace context automatically.

**Context Propagation:**
- `extractContext(headers)` — Extracts OpenTelemetry trace context from incoming HTTP/gRPC headers (W3C Trace Context).
- `injectContext(headers)` — Injects current trace context into outgoing headers.
- `getTraceId()`, `getSpanId()` — Read trace/span identifiers from the current async context.
- `withContext(context, fn)` — Wraps an async operation with explicit context.
- `PropagationHeaders` — Enum of header names (`traceparent`, `tracestate`).
- Types: `HeaderCarrier`.

## Dependencies

- **`pino`** — High-performance structured JSON logger (v9.6+).
- **`@opentelemetry/api`** — OpenTelemetry API (traces, metrics, context).
- **`@opentelemetry/exporter-trace-otlp-http`** — OTLP HTTP trace export.
- **`@opentelemetry/sdk-metrics`** — OpenTelemetry metrics SDK.
- **`@opentelemetry/sdk-node`** — Node.js SDK bundle for auto-instrumentation.
- **`@opentelemetry/sdk-trace-base`** — Base trace SDK.
- All runtime dependencies; no dev-only OpenTelemetry packages.

Dev dependency: `@opentelemetry/context-async-hooks` (for test environments).

## Used By

This is the most widely-used internal library — **seven packages** depend on it:
- [[ontology-engine]] — Object and link lifecycle spans.
- [[action-executor]] — Action pipeline spans for each pipeline stage.
- [[api-gateway]] — Request-level spans, rate limiter metrics, structured access logs, graceful shutdown.
- [[security-service]] — Auth check spans, audit write spans.
- [[storage-postgres]] — Database query spans, connection pool health gauges.
- [[sync-engine]] — Extraction/ingestion spans, sync lag gauges.

## Key Design Decisions

- **Shared instrumentation, not per-package** — All packages use the same `getTracer`/`withSpan`/`createLogger` utilities from this library. This ensures consistent span naming, attribute conventions, and log format across the entire platform.
- **OTLP HTTP, not gRPC** — The trace exporter uses OTLP over HTTP to maximize firewall compatibility and simplify certificate management in enterprise deployments.
- **Log-trace correlation** — Every log line includes `trace_id` and `span_id` from the OpenTelemetry context. This enables full correlation between structured logs and distributed traces in observability backends (Jaeger, Grafana, Datadog).
- **Metrics at `/metrics`** — Prometheus metrics are exposed on the standard `/metrics` endpoint but protected from external access in production.

## Test Coverage

- **2 test files**: `tracer.test.ts` (tracer creation, span wrapping, context propagation), `metrics.test.ts` (metric registration, gauge/ histogram creation).

## Sources

- [Source: open-foundry-spec-v2.md Section 4.5 — Ontology Engine Observability]
- [Source: open-foundry-spec-v2.md Section 13 — Non-Functional Requirements]
- [Source: open-foundry-spec-v2.md Section 13.1 — Performance Targets]
