---
title: Action-Oriented Architecture
created: 2026-06-18
last_updated: 2026-06-18
type: concept
status: active
related_components:
  - actions
  - api-gateway
  - security-service
  - ontology-engine
---

# Action-Oriented Architecture

Open Foundry is **action-oriented**: objects are created and mutated only through governed actions, not through generic per-type CRUD operations. There is no `POST /api/v1/Patient` or `mutation { createPatient }` endpoint. Instead, a patient is created through the `AdmitPatient` action, discharged through `DischargePatient`, and transferred through `TransferWard`. Every mutation is a domain-meaningful event with preconditions, authorization, consent, audit, and side-effects.

## Why Action-Oriented

Generic CRUD is semantically lossy. A `POST /api/v1/Patient` with `{ status: "DISCHARGED" }` loses the context: who discharged the patient, to what destination, under what clinical rationale, and with what side-effects (notification to the receiving ward, discharge letter to the GP). An `AdmitPatient` action captures all of this in its input parameters, preconditions, effects, and audit trail.

This is the key insight: **the ontology is not just a data model — it is a model of real-world operations.** Actions are the verbs. Objects are the nouns. The action pipeline ensures every verb is governed.

## How Actions Work

### Definition

An action is defined in two parts:
1. **ODL declaration** — The ActionType's input parameter schema, defined as a GraphQL type with `@actionType` and `@param` directives.
2. **YAML manifest** — The action's behavior: preconditions (CEL), effects (SPI operations), side-effects (webhooks/events), and rollback policy.

```graphql
# ODL — defines the API signature
type DischargePatient @actionType {
  patient: Patient! @param
  destination: DischargeDestination! @param
  notes: String @param
}
```

```yaml
# YAML manifest — defines the behavior
action: DischargePatient
version: 1

preconditions:
  - expr: "patient.status == 'ACTIVE'"
    error: "Patient is not currently active"
  - expr: "actor.hasRole('clinician') || actor.hasRole('nurse_in_charge')"

effects:
  - type: updateObject
    target: "patient"
    set:
      status: "DISCHARGED"
  - type: deleteLink
    linkType: "AdmittedTo"
    filter: { from: "patient", to: "patient.currentWard", active: true }
    expect: ONE
  - type: createObject
    objectType: "DischargeRecord"
    properties:
      patient: "patient"
      destination: "params.destination"
      dischargeDate: "now"

sideEffects:
  - name: notifyDestination
    type: webhook
    config:
      url: "https://integration.nhs.uk/discharge-notifications"

rollback:
  onSideEffectFailure: LOG_AND_CONTINUE
```

### Execution

Every action passes through the mandatory 7-step pipeline:
1. **Validate** — Schema validation of parameters against ODL.
2. **Authorize** — ReBAC permission check via OpenFGA.
3. **Consent** — Data subject consent check (if activated).
4. **Preconditions** — CEL guard conditions evaluated.
5. **Execute** — Effects applied in a single SPI transaction.
6. **Side-Effects** — Webhooks and events triggered (async, post-commit).
7. **Audit** — Immutable audit record written.
8. **Emit** — CloudEvents published.

There are no shortcuts. No API, connector, or internal process can bypass any step.

## The API Surface

Actions are exposed through every API surface:

### GraphQL
```graphql
mutation {
  dischargePatient(input: {
    patient: "patient-abc-123"
    destination: HOME
    notes: "Recovered well. Follow-up in 2 weeks."
  }) {
    success
    actionId
    errors { code message }
    affectedObjects { type id changeType }
  }
}
```

### REST
```
POST /api/v1/actions/DischargePatient
{
  "patient": "patient-abc-123",
  "destination": "HOME",
  "notes": "Recovered well."
}
```

### FHIR
FHIR write operations (POST/PUT/DELETE) are translated to corresponding ActionTypes via the Domain Pack's `fhir.mutations` mapping. For example, `POST /fhir/Patient` maps to the `AdmitPatient` action. There is no direct FHIR write path to the ontology store.

### TypeScript SDK
```typescript
const result = await of.actions.dischargePatient({
  patient: 'patient-abc-123',
  destination: 'HOME',
  notes: 'Recovered well.'
});
```

## What Actions Provide That CRUD Cannot

### Semantic Audit Trail
Every action execution produces an audit record with: the action type name, the actor, the input parameters, the before/after state of affected objects, the consent decision, and the result. A generic "update Patient" audit record tells you what changed. A "DischargePatient" audit record tells you what happened and why.

### Compensating Transactions
Actions can be declared `reversible: true`, enabling undo within a configurable time window. The undo is itself an action that passes through the full pipeline. A generic `DELETE` cannot be meaningfully undone. A `DischargePatient` undo restores the patient to ACTIVE, re-creates the `AdmittedTo` link, and records the reversal.

### AI-Ready Tool Interface
Every ActionType is exposed as a `ToolDescriptor` with a JSON Schema parameter definition directly compatible with LLM function-calling interfaces. An AI agent can discover available actions, preview their effects via `dryRun: true`, and submit them for human approval when tagged `highRisk`. See [[adr-005-action-pipeline]] for the AI-ready action envelope.

### Side-Effect Orchestration
Actions trigger side-effects (webhooks, event emissions) after the SPI transaction commits. This ensures external systems are notified of state changes without risking data inconsistency. A generic update has no concept of side-effects.

### Domain-Specific Validation
Preconditions encode domain rules that cannot be expressed in schema validation alone: "patient must be ACTIVE," "patient must currently be admitted," "only a clinician or nurse in charge can discharge." These rules live with the action definition, not scattered across middleware.

## Bulk and Dry-Run

Bulk actions execute N action instances through the full pipeline. Each item is validated, authorized, and audited independently. `dryRun: true` performs all checks and returns the projected effects without committing — enabling impact preview before execution.

## Sources

- [Source: open-foundry-spec-v2.md Section 5 — Action Framework]
- [Source: open-foundry-spec-v2.md Section 5.3 — Execution Pipeline]
- [Source: open-foundry-spec-v2.md Section 5.7 — AI-Ready Action Envelope]
- [Source: open-foundry-spec-v2.md Section 5.6 — Action Undo]
- [Source: README.md — Action Framework]
- [Source: README.md — REST API: governed actions via POST /api/v1/actions/{Name}]
- [Source: AGENTS.md — Reference: actions go through a mandatory pipeline]

## Related

- [[adr-005-action-pipeline]] — Decision record on the mandatory 7-step pipeline
- [[cel-expressions]] — CEL expressions used for preconditions and effects
- [[rebec-authorization]] — How ReBAC powers the Authorize step
- [[domain-pack-architecture]] — How domain packs bundle action manifests
- [[adr-002-cel-go-sidecar]] — How CEL evaluation in the pipeline works
