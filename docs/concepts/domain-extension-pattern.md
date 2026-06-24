---
title: domain-extension-pattern
created: 2026-06-20
type: concept
related_components:
  - sync-engine
  - ner-extraction
related_decisions:
  - adr-013-palantir-domain-pack-refactor
related_features:
  - domain-pack-palantir-refactor
  - osint-domain-pack
---

# Domain Extension Pattern — Dual Create + Linked Types

The pattern by which domain packs extend canonical core entity types with domain-specific attributes without modifying the core types themselves.

## The Problem

A Person tracked by OSINT needs `threatLevel` and `watchlistStatus`. A Person in a hospital needs `nhsNumber` and `bloodType`. A Person in financial crime needs `riskScore` and `sanctionsStatus`. If all these attributes live on the same `Person` type, it becomes a "kitchen sink" with 50+ fields, most of which are irrelevant to any given domain.

## The Pattern

**Core entity**: ~12 canonical attributes that apply to every person regardless of domain.
**Extension entity**: Domain-specific attributes + a link to the core entity.

```
Core Person:
  fullName, aliases, dateOfBirth, nationality           ← shared across ALL domains

├── IntelSubject (OSINT):                                ← OSINT domain
│     person → Person                                    ← link back to core
│     threatLevel, watchlistStatus, isPersonOfInterest    ← intel-specific
│
├── Patient (NHS):                                       ← NHS domain
│     person → Person                                    ← link back to core
│     nhsNumber, status, triageCategory                  ← medical-specific
│
└── CustomerProfile (AML, future):                       ← AML domain
      person → Person                                    ← link back to core
      riskScore, kycStatus                               ← financial-specific
```

## Dual Create Flow

### OSINT (automated NER pipeline)

```typescript
// entity-extraction-service.ts
case 'Person': {
  // Step 1: Create canonical Person (core)
  const person = await objectManager.create('Person', {
    fullName: entity.name,
    _normalizedName: normalizedName,
  }, ctx);

  // Step 2: Create intel extension (linked to Person)
  const subject = await objectManager.create('IntelSubject', {
    person: person._id,              // LINK to core
    watchlistStatus: 'NONE',
    isPersonOfInterest: false,
  }, ctx);

  return subject._id;  // Return extension ID for link creation
}
```

### NHS (action manifest)

```yaml
# register-patient.yaml
effects:
  - type: createObject
    objectType: "Person"
    properties:
      fullName: "params.name"
      dateOfBirth: "params.dateOfBirth"
  - type: createObject
    objectType: "Patient"
    properties:
      person: "person._id"         # Cross-effect reference via camelCase context key
      nhsNumber: "params.nhsNumber"
      status: "DISCHARGED"
```

## Why the Extension ID Is Returned

The caller (`processReport()` or the action executor) creates links that point to the extension type:

```
IntelReport ──MentiosSubject──→ IntelSubject (extension)
                                    │
                                    └─ProfileForPerson─→ Person (core)
```

If `createEntity()` returned the `Person._id`, links would target the wrong object type. The extension ID ensures links connect to the correct domain type.

## When NOT to Use This Pattern

- When only ONE domain pack will ever use the entity type (no cross-domain sharing needed)
- When the domain-specific attributes are truly universal (belong on the core entity itself)
- For entities that have no cross-domain counterpart (IntelEvent is domain-specific, no core counterpart)

## Sources

- [[adr-013-palantir-domain-pack-refactor]]
- [[domain-pack-palantir-refactor]]
- Palantir Foundry: Open for Extension, Closed for Modification principle
