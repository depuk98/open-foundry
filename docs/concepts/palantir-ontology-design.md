---
title: palantir-ontology-design
created: 2026-06-20
type: concept
related_components:
  - odl
  - api-gateway
related_decisions:
  - adr-013-palantir-domain-pack-refactor
related_features:
  - domain-pack-palantir-refactor
  - osint-domain-pack
---

# Palantir Ontology Design — 4-Layer Architecture

Open Foundry domain packs now follow Palantir Foundry's 4-layer ontology architecture, which separates entity types by their semantic role rather than their source system.

## The Four Layers

| Layer | Directory | What It Contains | Decision Rule |
|-------|-----------|-----------------|---------------|
| **Objects** | `objects/` | Real-world entities that exist independently of any observer | "Would this exist if nobody was watching?" → YES |
| **Observations** | `observations/` | Source artifacts — records OF something observed, raw data intake | "Is this a record of data received from an external source?" → YES |
| **Workflows** | `workflows/` | Human/agent-created work products — synthesis, analysis, monitoring rules | "Is this created by an analyst/agent as output of their work?" → YES |
| **Actions** | `actions/` | Kinetic operations — what humans/agents DO to the ontology | Always action manifests (.yaml files) |
| **Interfaces** | `interfaces/` (core only) | Cross-cutting type capabilities shared across packs | "Does this describe a capability that multiple types implement?" → interfaces/ |

## How Each Layer Was Applied

### OSINT Pack Example

```
objects/         IntelSubject, IntelOrganization, IntelLocation, IntelEquipment, IntelEvent
                 → The people, places, weapons, and events being tracked. They exist whether or not reported.

observations/    IntelReport, SourceProfile
                 → The tweet/message that mentions an entity, and metadata about who said it.

workflows/       Assessment, Indicator, Narrative
                 → Products synthesized by analysts — assessments, monitoring rules, story narratives.

actions/         corroborate-report.yaml, escalate-report.yaml, etc.
                 → What analysts DO to the ontology: verify, flag, assign credibility.
```

### NHS-Acute Pack Example

```
objects/         Patient, Consultant, Ward, Bed
                 → People and physical resources in the hospital.

observations/    DischargeRecord
                 → A record of a discharge event — not the event itself.

actions/         admit-patient.yaml, register-patient.yaml, etc.
                 → What clinicians DO: admit, discharge, transfer.
```

## Why This Matters

**Before (flat schema/)**: A developer looking at the OSINT pack couldn't tell what was a "real entity" vs "ingested data" vs "analyst work product." Everything looked the same.

**After (layered directories)**: The architecture is self-documenting. A new team member can navigate the directory tree and immediately understand: "these are the things we track, these are the reports that mention them, these are what analysts produce."

## Palantir's Influence

Palantir Foundry separates its Ontology into:
- **Semantic elements** — Object types + Link types (the "what")
- **Kinetic elements** — Action types + Functions (the "how")

Open Foundry's layers map to this:
- Objects + Interfaces → Semantic
- Actions → Kinetic
- Observations + Workflows → A pragmatic addition for source data provenance and analyst workflow tracking, which Palantir handles differently via pipeline metadata and application state.

## Sources

- [[adr-013-palantir-domain-pack-refactor]] — The architectural decision
- [[domain-extension-pattern]] — How dual creates work
- [[observations-vs-objects]] — Deeper dive on the observation/object distinction
- Palantir Foundry: Ontology Building Overview
- Palantir Foundry: Ontology Design Best Practices
