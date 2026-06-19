---
title: SDK TypeScript
created: 2026-06-18
last_updated: 2026-06-18
type: component
package: "@openfoundry/sdk"
status: stub
related_components:
  - odl
  - api-gateway
---

# SDK TypeScript

The `@openfoundry/sdk` package is the **auto-generated TypeScript client SDK** for the Open Foundry platform. It provides typed query methods, action invocations, and WebSocket subscription handlers derived from the ODL schema via the `generateSdk` function in [[odl]]. Currently a stub package — its source directory exports an empty namespace (`export {}`) as a placeholder, and the `test` script echoes `"no tests yet"`. The SDK generator in [[odl]] produces fully typed client code that this package will contain.

## Public API

**Current state (stub):**
- Exports an empty namespace — no public API yet.

**Planned API (per Spec Section 8.4):**
- `OpenFoundry` client class — Initialized with an API endpoint URL.
- Typed object queries: `of.Patient.get(id)`, `of.Patient.list(filter, pagination)`, `of.Patient.search(query)`, `of.Patient.aggregate(query)`.
- Typed link traversal: `patient.currentWard()`, `ward.patients({ filter })`.
- Typed action invocations: `of.actions.dischargePatient({ patient, destination, notes })` — fully type-checked.
- WebSocket subscriptions: `of.Patient.onChange(id, callback)` — typed change events.
- Field-level redaction support: the `Redacted` sentinel type distinguishes redacted fields from null/undefined.
- Supported targets: TypeScript/JavaScript (primary), with architecture designed for Python, Java, and Go codegen.

## Dependencies

- **None.** This package has zero runtime dependencies. The generated SDK code will depend on `graphql` and `graphql-ws` at minimum for the client runtime, but these are not yet wired in.

## Used By

- External consumer applications that interact with an Open Foundry API.
- The Nightingale reference app (bed board demo) — though currently Nightingale calls the REST/GraphQL API directly rather than through this SDK.
- Future UI components and third-party integrations.

## Key Design Decisions

- **Auto-generated, not hand-written** — The SDK is produced by `generateSdk()` in [[odl]], which walks the parsed schema and emits TypeScript classes, types, and methods. This ensures the SDK is always in sync with the ODL schema — when the schema changes, re-running `generateSdk` updates the SDK.
- **Placeholder package** — The package exists as a build target so that the SDK generator output has a destination. The stub export enables type-checking across the monorepo without failing on missing exports.
- **Field-level security in the SDK** — The SDK distinguishes redacted fields at the type level (`Redacted` sentinel), making it impossible for consumers to accidentally treat redacted data as real data. This is security by construction.

## Test Coverage

- **0 test files** — No tests yet. The `test` script is `echo "no tests yet"`.

## Sources

- [Source: open-foundry-spec-v2.md Section 8.4 — Client SDKs]
