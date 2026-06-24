---
title: palantir-four-principles-applied
created: 2026-06-20
type: concept
related_components:
  - odl
  - sync-engine
  - twitter-connector
  - ner-extraction
related_decisions:
  - adr-013-palantir-domain-pack-refactor
related_features:
  - domain-pack-palantir-refactor
  - osint-domain-pack
  - nhs-acute-pilot
---

# Palantir's 4 Principles — Traced Through Open Foundry Code

How each of Palantir Foundry's 4 ontology design principles manifests in specific files, code paths, and ODL declarations.

---

## IntelReport: Observation or Entity?

Technical reality: everything in ODL marked `@objectType` gets a DB table. From PostgreSQL's perspective, `intel_report` and `person` are both tables with rows. The distinction is **semantic**, not storage-level.

```
Database                     Semantic Layer (Palantir)
────────                     ────────────────────────
intel_report table           ← OBSERVATION: "a record of data received"
person table                 ← CORE OBJECT: "what exists in the real world"
intel_subject table          ← DOMAIN OBJECT: "what OSINT cares about"
assessment table             ← WORKFLOW: "what an analyst produced"
```

The `observations/` directory convention says: "This type represents source data intake — it would not exist if nobody was watching." `objects/` says: "This type represents something real that exists independently." The runtime treats both identically. This matches Palantir Foundry's model: an Observation is a dataset row, an Object is also a dataset row — the distinction is in ontology design, not storage.

---

## Principle 1: Domain-Driven Design — "Model the real world, not the source data"

**What it means**: The ontology models domain concepts, not ingestion pipeline artifacts. Source system quirks stay in the connector, never leak into the knowledge graph.

### Where It Lives

**twitter-connector.ts** — the SOURCE data with platform artifacts:
```typescript
const tweet = {
  tweet_id: "1834567890123456789",
  text: "Zelensky met NATO in Bakhmut",
  author_id: "12345",
  retweet_count: 42,         // ← Twitter artifact, NOT in ontology
  favorite_count: 15,        // ← Twitter artifact, NOT in ontology
};
```

**server.ts changeApplier** — the MODEL, stripping artifacts:
```typescript
objectManager.create('IntelReport', {
  content: tweet.text,                       // ← domain attribute
  sourceChannel: `@${tweet.author_handle}`,  // ← domain attribute
  sourcePlatform: 'twitter',                  // ← domain attribute
  retrievedAt: now,                           // ← domain attribute
  // tweet_id NOT stored in IntelReport
  // retweet_count NOT stored
});
```

**Result**: The tweet's `tweet_id`, `retweet_count`, and `favorite_count` are Twitter platform artifacts that never enter the ontology. Only semantically meaningful, domain-level fields become `IntelReport` attributes. If you later switch from Twitter to Telegram as a data source, the ontology doesn't change — only the connector's mapping logic.

**Enforced by**: The `observations/` directory convention. IntelReport lives in `osint/observations/` — it's a record OF something observed, not a real-world entity.

---

## Principle 2: Don't Repeat Yourself — One canonical entity, linked by all domains

**What it means**: If three domain packs need a Person concept, define it ONCE in core. Each pack extends it via a linked type, not by duplicating fields.

### The Duplication Problem (Before)

```
osint/schema/person.odl:       fullName: String!      ← copy 1
                                dateOfBirth: Date      ← copy 1

nhs-acute/schema/patient.odl:  name: String!          ← copy 2
                                dateOfBirth: Date      ← copy 2

aml/schema/customer.odl:       fullName: String!      ← copy 3
                                dateOfBirth: Date      ← copy 3
```

### The Single Source of Truth (After)

**core/objects/person.odl** — THE canonical fields:
```odl
type Person implements Identifiable & Auditable & Locatable @objectType {
  fullName: String! @searchable(weight: 2.0)
  aliases: [String!] @searchable
  dateOfBirth: Date @sensitive
  nationality: Country @indexed
  // ... ~16 fields total, shared across ALL domains
}
```

**osint/objects/intel-subject.odl** — links to core:
```odl
type IntelSubject implements Identifiable & Auditable @objectType {
  person: Person! @link(type: "ProfileForPerson", direction: OUTBOUND)
  threatLevel: ConfidenceLevel
  watchlistStatus: WatchlistStatus
  // ... intel-specific fields only
}
```

**nhs-acute/objects/patient.odl** — links to core:
```odl
type Patient @objectType {
  person: Person! @link(type: "PatientProfileForPerson", direction: OUTBOUND)
  nhsNumber: String @unique @indexed
  status: PatientStatus!
  // ... NHS-specific fields only
}
```

**Impact**: If `middleName` is added to core Person, all three domain packs get it automatically. No duplication. The `Patient.name` and `Patient.dateOfBirth` fields were removed — they now live on core Person, accessible via `patient.person.fullName`.

---

## Principle 3: Open for Extension, Closed for Modification — Core types are locked

**What it means**: Once a core entity type is field-tested, its structure is frozen. Adding new capabilities means creating NEW linked types — never modifying the core type.

### Core Equipment (CLOSED)

**core/objects/equipment.odl** — ~6 fields, never modified:
```odl
type Equipment implements Identifiable & Auditable @objectType {
  designation: String! @searchable(weight: 1.8)
  commonName: String @searchable
  manufacturer: String
  originCountry: Country @indexed
  specifications: JSON
  _normalizedName: String @indexed
}
```

### OSINT Extension (OPEN)

**osint/objects/intel-equipment.odl** — linked, intel-specific:
```odl
type IntelEquipment implements Identifiable & Auditable @objectType {
  equipment: Equipment! @link(type: "EquipmentProfileForEquipment")
  category: EquipmentCategory! @indexed
  natoReportingName: String @indexed
  capabilities: [String!] @searchable
  vulnerabilities: [String!]
  lossesConfirmed: Int
  lossesClaimed: Int
  lastLossRecorded: DateTime
}
```

### Future Supply-Chain Extension (OPEN, hypothetical)

```odl
type WarehouseEquipment implements Identifiable & Auditable @objectType {
  equipment: Equipment! @link(type: "WarehouseProfileForEquipment")
  maintenanceSchedule: DateTime
  lastInspected: DateTime
  operatorCertification: String
}
```

**Enforced by**: The `core/` vs domain pack boundary. Domain packs can only `@link` to core types, never modify them. The pack.yaml dependency (`openfoundry.core: ">=1.0.0"`) ensures core loads first.

---

## Principle 4: Composition over Deep Hierarchies — Interfaces, not inheritance chains

**What it means**: Shared capabilities are interfaces that types compose freely. No deep inheritance trees. An action built on an interface works on ALL types that implement it.

### Existing Interfaces

**core/schema/core.odl**:
```odl
interface Identifiable { id, createdAt, createdBy }
interface Auditable   { updatedAt, updatedBy }
interface Locatable   { location, address }
interface Temporal    { validFrom, validTo }
```

### How Types Compose Them

```odl
// osint/objects/intel-subject.odl — no Locatable
type IntelSubject implements Identifiable & Auditable { ... }

// osint/objects/intel-event.odl — composes FOUR
type IntelEvent implements Identifiable & Auditable & Locatable & Temporal { ... }

// nhs-acute/objects/patient.odl — no Locatable
type Patient implements Identifiable & Auditable { ... }
```

### Future: Adding Verifiable

```odl
// core/interfaces/verifiable.odl — NEW
interface Verifiable {
  verificationStatus: VerificationStatus  // UNVERIFIED | CORROBORATED | CONTRADICTED
  verifiedBy: String
  verifiedAt: DateTime
}

// Types adopt it:
type IntelReport implements Identifiable & Auditable & Verifiable { ... }
type Assessment  implements Identifiable & Auditable & Verifiable { ... }

// One action works on ANY Verifiable type:
action: Corroborate
effects:
  - type: updateObject
    objectType: "any:Verifiable"
    set: { verificationStatus: "CORROBORATED" }
```

---

## Summary: Where Each Principle Lives

| Principle | Lives In | Concrete Location |
|-----------|----------|-------------------|
| #1 DDD | `changeApplier` strips source artifacts; ODL types model domain concepts | `twitter-connector.ts → server.ts changeApplier → IntelReport/IntelSubject` |
| #2 DRY | One canonical Person/Org/Loc/Eq in `core/objects/`; all domains link to it | `core/objects/person.odl` + `core/links.odl` + `osint/objects/intel-subject.odl` + `nhs-acute/objects/patient.odl` |
| #3 Open-Closed | Core types are small and stable; domain extensions add fields via linked types | `core/objects/equipment.odl` (6 fields, locked) vs `osint/objects/intel-equipment.odl` (extension) |
| #4 Composition | Interfaces compose capabilities; actions target interfaces, not concrete types | `core/schema/core.odl` (Identifiable, Auditable) + future `Verifiable`, `Credible`, `Monitored` |

## Sources

- [[adr-013-palantir-domain-pack-refactor]]
- [[palantir-ontology-design]]
- [[domain-extension-pattern]]
- [[observations-vs-objects]]
- Palantir Foundry: Ontology Design Best Practices
