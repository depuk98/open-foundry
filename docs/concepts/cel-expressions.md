---
title: CEL Expressions for Action Preconditions and Effects
created: 2026-06-18
last_updated: 2026-06-18
type: concept
status: active
related_components:
  - cel-evaluator
  - actions
  - odl-compiler
---

# CEL Expressions for Action Preconditions and Effects

**CEL (Common Expression Language)** is the expression language used throughout Open Foundry for action preconditions, effect expressions, field-level `@constraint` validation, data migration transforms, and data quality rules. It is Google's open-source expression language designed for evaluating security policies and business rules in a safe, sandboxed, performant manner.

## Why CEL

CEL was chosen because it is:
- **Well-specified** — Formal grammar, type-checked at schema compilation time, not just at runtime.
- **Fast** — Microsecond-scale evaluation. Hundreds of precondition checks per action without bottleneck.
- **Safe by design** — No loops, no I/O, no side-effects, guaranteed termination. Cannot deadlock or hang.
- **Production-quality implementations** — Go (`cel-go`), Java (`cel-java`), C++ (`cel-cpp`). Open Foundry uses the Go implementation via a gRPC sidecar. See [[adr-002-cel-go-sidecar]].

## Where CEL Is Used

### 1. Action Preconditions
Guard conditions that must be true before an action executes:

```yaml
preconditions:
  - expr: "patient.status == 'ACTIVE'"
    error: "Patient is not currently active"
  - expr: "patient.currentWard != null"
    error: "Patient is not currently admitted"
  - expr: "actor.hasRole('clinician') || actor.hasRole('nurse_in_charge')"
    error: "Only clinicians or nurses in charge can discharge patients"
```

### 2. Action Effects
Value expressions for effect properties, evaluated against the immutable action context:

```yaml
effects:
  - type: updateObject
    target: "patient"
    set:
      status: "DISCHARGED"
      dischargeDate: "now"
      expectedArrival: "now + duration('PT2H')"
```

### 3. Field Constraints
Validation expressions on `@constraint` directives (field-level and type-level):

```graphql
# Field-level: value refers to the proposed field value
type Ward @objectType {
  capacity: Int! @constraint(expr: "value > 0")
  name: String! @constraint(expr: "value.size() >= 2 && value.size() <= 100")
}

# Type-level: this refers to the full proposed object
type TheatreSlot @objectType @constraint(expr: "this.endTime > this.startTime") {
  startTime: DateTime!
  endTime: DateTime!
}
```

### 4. Data Migration Transforms
CEL expressions for reshaping data during schema migrations:

```yaml
transforms:
  - objectType: Ward
    set:
      specialtyCode: "mapSpecialtyCode(specialty)"
      specialtyDisplay: "specialty"
```

### 5. Data Quality Rules
Cross-object and temporal quality rules:

```yaml
rule: ward_occupancy_over_capacity
expr: "ward.currentOccupancy > ward.capacity * 1.2"
```

## CEL Environment

When an action executes, CEL expressions are evaluated within a defined environment:

### Variables

| Variable | Type | Description |
|----------|------|-------------|
| `params` | dynamic | The action's input parameters |
| `actor` | Actor | The user or system executing the action |
| `now` | `google.protobuf.Timestamp` | Current UTC timestamp (variable, not function) |

**Parameter variables:** Each `@param` field on the ActionType is available as a top-level variable containing the fully-resolved object (not just the ID). For example, `patient` refers to the full `Patient` object with all its properties and links. These are immutable snapshots resolved at action start — they do not change as effects are applied.

### Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `has_link` | `(object, linkType: string) -> bool` | Whether the object has an active link of the given type |
| `count_links` | `(object, linkType: string) -> int` | Count of active links of the given type |
| `actor.hasRole` | `(role: string) -> bool` | Whether the actor has the specified role |
| `actor.hasPermission` | `(permission: string, resource: string) -> bool` | Whether the actor has the specified permission on the resource |
| `duration` | `(iso8601: string) -> google.protobuf.Duration` | Parses an ISO 8601 duration string |

## ODL to CEL Type Mapping

The ODL compiler type-checks all CEL expressions at schema compilation time:

| ODL Type | CEL Type |
|----------|----------|
| `String` | `string` |
| `Int` | `int` |
| `Float` | `double` |
| `Boolean` | `bool` |
| `DateTime` | `google.protobuf.Timestamp` |
| `Duration` | `google.protobuf.Duration` |
| `Date` | `string` (ISO 8601) |
| ObjectTypes | `map` (property access via dot notation) |
| Enums | `string` (compared by enum value name) |

## Null Safety

CEL uses explicit null checking — accessing a property on a null value is a runtime error, not null propagation:

```yaml
# WRONG — will error if currentWard is null
- expr: "patient.currentWard.name == 'Ward A'"

# CORRECT — guard the null case
- expr: "patient.currentWard != null && patient.currentWard.name == 'Ward A'"

# ALSO CORRECT — use has() macro
- expr: "has(patient.currentWard) && patient.currentWard.name == 'Ward A'"
```

The ODL compiler warns about potential null-access paths at compile time based on schema optionality declarations.

## Execution Security

CEL expressions are evaluated in the Go `cel-evaluator` sidecar, not in the TypeScript runtime. The sidecar:
- Runs CEL expressions with **no I/O access** and **no side-effects**.
- Enforces **execution time limits** per expression.
- Returns **deterministic results** matching Google's reference implementation.
- Is isolated from the Node.js runtime via gRPC.

The CEL evaluator does not directly access the SPI or ontology store — all object data is resolved by the TypeScript Action Framework and passed to the evaluator as a pre-assembled variable environment. This means CEL expressions cannot bypass authorization, consent, or audit.

## Sources

- [Source: open-foundry-spec-v2.md Section 5.2 — Expression Language]
- [Source: open-foundry-spec-v2.md Section 5.2.1 — CEL Environment]
- [Source: open-foundry-spec-v2.md Section 5.2.2 — Null Propagation]
- [Source: open-foundry-spec-v2.md Section 5.2.3 — Type System]
- [Source: open-foundry-spec-v2.md Section 2.3.2 — @constraint Directive Semantics]
- [Source: README.md — Action Framework: CEL sidecar]

## Related

- [[adr-002-cel-go-sidecar]] — Decision record on why CEL runs in Go gRPC sidecar
- [[action-orientation]] — How CEL preconditions gate the Execute step
- [[adr-005-action-pipeline]] — Where CEL fits in the 7-step pipeline
- [[odl-schema-driven]] — How ODL types map to CEL types
