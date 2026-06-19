---
title: ADR-005 — Mandatory 7-Step Action Pipeline
created: 2026-06-18
last_updated: 2026-06-18
type: decision
status: accepted
related_components:
  - actions
  - security-service
  - ontology-engine
  - cel-evaluator
---

# ADR-005: Mandatory 7-Step Action Pipeline

## Context

All mutations in Open Foundry — creating patients, discharging patients, transferring wards, flagging transactions — must be governed. An ungoverned mutation path (e.g., a REST endpoint that writes directly to the SPI) would bypass authorization, consent, validation, and audit, creating security gaps and regulatory non-compliance. We needed a structured, non-bypassable pipeline that ensures every mutation is governed consistently.

## Decision

**Every action executes through a mandatory 7-step pipeline: Validate → Authorize → Consent → Preconditions → Execute → Side-Effects → Audit → Emit.** The ordering is deliberate and enforced by the Action Framework. No API, connector, or internal process can bypass any step.

The pipeline order is security-critical:
1. **Validate** — Schema validation of input parameters against the ActionType definition.
2. **Authorize** — Security Layer checks the actor's ReBAC permissions for the target objects. Runs *before* preconditions to prevent information leakage via precondition error messages (an unauthorized user probing object state by submitting actions and observing which precondition failed).
3. **Consent** — Consent layer checks data access consent if the Domain Pack activates it. Runs after authorization because a user can be authorized in general but the specific data subject may have withheld consent.
4. **Preconditions** — Evaluate all CEL precondition expressions against the current object state (e.g., `patient.status == 'ACTIVE'`).
5. **Execute** — Apply effects in a single SPI transaction. Effects run strictly in manifest order against an immutable action context snapshot.
6. **Side-Effects** — Trigger webhooks, event bus notifications, or external API calls (HTTP webhooks, event emissions). Async post-commit; failures handled per `rollback.onSideEffectFailure` policy.
7. **Audit** — Write immutable audit record with before/after state, actor identity, trace ID, consent decision, and result.
8. **Emit** — Publish CloudEvents to the event bus for downstream consumers.

## Alternatives Considered

- **Ad-hoc governance** — Each API endpoint implements its own checks. Rejected because: inconsistent enforcement, easy to accidentally bypass a check, impossible to audit comprehensively, and every new action type would require duplicating governance logic.
- **Fewer pipeline steps** — Combine authorization with consent, or preconditions with execution. Rejected because: each step has distinct failure modes and error codes. A consent denial (`CONSENT_DENIED`) must be distinguishable from an authorization denial (`ACCESS_DENIED`) for regulatory compliance and user-facing error messages. Consolidating steps would lose this distinction.
- **Configurable pipeline** — Allow domain packs to reorder or skip pipeline steps. Rejected because: creates combinatorial security testing burden. A domain pack that skips consent for "performance reasons" would violate healthcare regulations. The pipeline is non-configurable by design — it is the invariant that all mutations share.

## Consequences

### What becomes easier

- **Guaranteed governance** — Every mutation, whether from GraphQL, REST, FHIR, a connector, or an AI agent, passes through the exact same pipeline. There are no backdoors. See [[action-orientation]].
- **Consistent error model** — Pipeline failures at each step produce structured errors with distinct codes (`VALIDATION_ERROR`, `ACCESS_DENIED`, `CONSENT_DENIED`, `PRECONDITION_FAILED`, `EFFECT_FAILED`, `SIDEEFFECT_FAILED`). Consumers can handle each failure category appropriately.
- **Pipeline-ordering security** — Running Authorization before Preconditions prevents an attacker from probing object state via precondition error messages. An unauthorized user gets `ACCESS_DENIED` — they never learn whether `patient.status == 'ACTIVE'`.
- **Immutable action context** — Effect expressions are evaluated against a snapshot of `params`, resolved parameter variables, `actor`, and `now` captured at action start. Effects do not re-bind to post-effect database state, ensuring deterministic execution regardless of effect ordering.
- **Compensating transactions** — The `ROLLBACK_ALL` rollback strategy restores prior object and link state on failure. The pipeline's transaction boundary (all effects in one SPI transaction) makes this possible. See [[actions]].

### What becomes harder

- **Pipeline overhead** — Every action, no matter how simple, runs through all steps. For a trivial action (e.g., updating a single field), the validate-authorize-consent-precondition steps add overhead. The spec targets < 500ms p99 for action execution with 2 side-effects, which is achievable with optimized OpenFGA checks (< 5ms) and CEL evaluation (microseconds).
- **Debugging pipeline failures** — When an action fails, the error could originate from any of 7 steps. The audit trail and structured error envelope include the failing step and reason, but distributed tracing (OpenTelemetry spans per step) is essential for debugging. See [[observability]].
- **Bulk action complexity** — Each item in a bulk action passes through the full pipeline independently (unless `allOrNothing: true`). This means 10,000 dry-run items require 10,000 full pipeline traversals, which the spec targets at < 30 seconds.

## Sources

- [Source: open-foundry-spec-v2.md Section 5.3 — Execution Pipeline]
- [Source: open-foundry-spec-v2.md Section 5.3 — Pipeline ordering rationale]
- [Source: open-foundry-spec-v2.md Section 5.5 — Bulk Action Execution]
- [Source: README.md — Action Framework]
- [Source: AGENTS.md — Reference: Package Architecture]

## Related

- [[action-orientation]] — Concept page on objects mutated only through governed actions
- [[cel-expressions]] — Concept page on CEL for preconditions and effects
- [[rebec-authorization]] — Concept page on ReBAC that powers the Authorize step
- [[adr-002-cel-go-sidecar]] — How CEL evaluation in the pipeline works
- [[adr-003-rebac-via-openfga]] — How ReBAC powers the Authorize step
