---
title: observations-vs-objects
created: 2026-06-20
type: concept
related_components:
  - sync-engine
  - twitter-connector
related_decisions:
  - adr-013-palantir-domain-pack-refactor
related_features:
  - domain-pack-palantir-refactor
  - osint-domain-pack
---

# Observations vs Objects — The Semantic Distinction

A foundational concept in Open Foundry's ontology: not everything stored in the database is a "real-world entity." Some things are records OF something observed, not the thing itself.

## The Distinction

| Aspect | Observation | Object |
|--------|------------|--------|
| **What it is** | A record of data received from an external source | A real-world entity that exists regardless of any observer |
| **Example** | IntelReport (a tweet), DischargeRecord (a discharge event record) | Person (Zelensky), Equipment (a T-90M tank), Ward (a hospital ward) |
| **Would it exist if nobody was watching?** | No — the report exists BECAUSE someone observed and recorded it | Yes — the person, tank, or ward exists whether or not it's being tracked |
| **Lifecycle** | Immutable raw intake → may be flagged, verified, or contradicted | Created, updated, enriched over time as more data arrives |
| **Directory** | `observations/` | `objects/` |

## The Tweet Example

A tweet IS NOT an entity. A tweet IS a source observation that REFERENCES entities:

```
Tweet from @UAWeapons: "T-90M destroyed near Bakhmut"

This is:

An OBSERVATION:   IntelReport { content: "T-90M destroyed near Bakhmut", sourceChannel: "@UAWeapons" }
                                │
References ENTITIES:           ├── IntelEquipment(T-90M) → Equipment(core)
                               └── IntelLocation(Bakhmut) → Location(core)

The tweet_id, retweet_count, favorite_count — these are Twitter platform artifacts.
They NEVER enter the ontology. Only the semantically meaningful fields (content,
source, timestamp) become IntelReport attributes.
```

## Why the Distinction Matters

1. **Source provenance is preserved**: You can always trace an entity back to the observation that first documented it. This is critical for intelligence analysis — who said what, and when.

2. **Observations can be wrong**: A tweet may claim T-90M was "destroyed" but a later report shows it was only damaged. The observation is a claim, not a fact. The object (T-90M) exists independently of the claim.

3. **Cross-domain reuse**: A core Person referenced by an OSINT IntelSubject may also be referenced by an NHS Patient. The observation layers (IntelReport, DischargeRecord) are independent and domain-specific.

4. **Analyst workflow**: Observations are immutable intake. Analysts create workflow products (Assessment, Indicator) that synthesize multiple observations into actionable intelligence.

## How It's Implemented

Both observations and objects are `@objectType` declarations in ODL — technically identical at the database level. Both get PostgreSQL tables. The distinction is a **semantic convention** enforced by directory placement:

```
osint/observations/intel-report.odl  → intel_report table
osint/objects/intel-subject.odl      → intel_subject table
```

The runtime (ObjectManager, GraphQL codegen) treats them identically. The directory placement is for human and AI understanding — the code doesn't enforce the distinction.

## Palantir's Take

Palantir Foundry doesn't have an explicit "observations" concept — it handles source data as pipeline artifacts (datasets, transforms) rather than ontology types. Open Foundry's approach (making observations first-class ontology types) is more appropriate for an open-source system where source provenance is a core feature and the audit trail must be visible to end users.

## Sources

- [[palantir-ontology-design]]
- [[domain-extension-pattern]]
- Palantir Foundry: Domain-Driven Design principle
- STIX 2.1: Observed Data vs Domain Objects
