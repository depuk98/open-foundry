# Spec: Domain Pack Architecture — Palantir Principles Refactor

## Objective

Restructure all 5 Open Foundry domain packs to follow Palantir's 4 design principles by separating entity types into architectural layers (objects/observations/workflows/actions/interfaces). Rename shared entity types (Person, Organization, Location, Equipment) with domain-specific prefixes so NHS-Acute and OSINT can use the same conceptual entities with different attributes without conflating schemas.

**Target users**: Developers extending Open Foundry with new domain packs, and the AI agents that maintain the codebase.

**What success looks like**:
- `core/objects/person.odl` defines the canonical Person (fullName, aliases, dateOfBirth, nationality, contact info, location). All domains use this.
- `osint/objects/intel-subject.odl` links to core Person + adds intel-specific attributes (threatLevel, watchlistStatus, isPersonOfInterest). **Dual record: core Person + IntelSubject per extracted entity.**
- `nhs-acute/objects/patient.odl` links to core Person + adds NHS-specific attributes (nhsNumber, status, triageCategory). **Dual record: core Person + Patient per registered patient.**
- `nhs-acute/objects/consultant.odl` links to core Person + adds consultant-specific attributes (gmcNumber, specialty). **Dual record: core Person + Consultant per consultant.**
- Entity extraction creates 2 records per person entity (core Person + domain extension)
- Patient registration creates 2 records (core Person + Patient)
- All domain packs organized into `objects/`, `observations/`, `workflows/`, `actions/` subdirectories
- 302 TypeScript tests pass, build succeeds, `docker compose` stack starts clean

---

## Context — Why This Matters Now

**Current problem**: The `osint` domain pack defines `Person` with intelligence-specific attributes (`threatLevel`, `watchlistStatus`, `isPersonOfInterest`) embedded directly in the Person type. When the `nhs-acute` pack was built, it created its own `Patient` type with a duplicate `name` and `dateOfBirth` field because there was no canonical Person to extend. The `aml` pack did the same with `Customer`. Three domain packs now have 3 different copies of the same Person fields.

**What this blocks**: Cross-domain queries ("show me everything known about John Smith across all domains"), entity linkage between packs, and clean separation of domain-specific attributes from universal human attributes.

**Palantir's approach applied**: 
- Principle #1 (Domain-Driven Design): Model the real world. A Person is a Person, regardless of which domain observes them.
- Principle #2 (Don't Repeat Yourself): One canonical Person, extended by each domain. Not three copies.
- Principle #3 (Open for Extension, Closed for Modification): Core Person is closed. Domains extend via domain-specific linked types.
- Principle #4 (Composition over Deep Hierarchies): Capabilities like `Verifiable`, `Credible` compose via interfaces, not inheritance chains.

---

## Assumptions

1. Domain packs share a PostgreSQL database schema — entities across packs live in the same database with tenant-scoped separation.
2. `objectManager.create()` can handle fields from any ODL-declared type, including newly created extension types, as long as they're in the ODL schema.
3. `docker compose down -v` is acceptable during the migration since the development stack has no production data.
4. Entity extraction labels (`'Person'`, `'Organization'`, etc.) are NER model output strings and are independent of ODL type names.
5. The `core/` domain pack exists and is loaded before all other packs at startup.
6. No production data exists in the OSINT or NHS-Acute tables that needs preservation.

### Trade-offs

| Trade-off | Rationale |
|-----------|-----------|
| Type proliferation (6 ODL files → 12) vs. clean separation | More files, but each file has a single responsibility. A developer working on the intel domain opens `objects/intel-subject.odl` and sees ONLY intel fields — not a 45-line file mixing core and domain attributes. |
| Rename breaks existing API consumers | GraphQL/REST auto-generate from schema, so endpoints update automatically. Any external clients referencing `Person` by name will break — they must update to `IntelSubject`. |
| `core/` pack becomes a dependency | All domain packs now depend on `core/`. This is intentional — it enforces the Don't Repeat Yourself principle. If a pack doesn't need core entities, it can skip the dependency. |
| One-time DB volume wipe required | Schema checksums change when ODL files move. `docker compose down -v` is the simplest path for development. |

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| NER labels conflict with new type names | Low | Low | NER labels (`Person`, `Organization`) are extraction model output, independent of ODL type names. |
| Link type references break | Medium | High | All link types reference entity type names. Must update 30+ link definitions. |
| `createEntity()` returns wrong ID for linking | High | Critical | `createEntity()` must return extension ID (IntelSubject._id), not core ID (Person._id). The caller creates MentiosSubject links → needs IntelSubject as target. |
| NHS register-patient creates Person without `_normalizedName` | Medium | Medium | `_normalizedName` is **optional** (`String`, not `String!`) on core Person. NHS doesn't set it — patients are unique by `nhsNumber`, not name. Dedup gracefully handles NULL via partial index. |
| `_normalizedName` designed as optional | Low | Low | Core Person declares `_normalizedName: String` (not `String!`). OSINT always populates it via `normalizeForDedup()`. NHS may not. `queryByName()` handles NULL: no match → creates fresh. Index is partial: `WHERE _normalized_name IS NOT NULL`. |
| GraphQL API consumers break | Medium | Medium | Types are renamed, GraphQL schema auto-regenerates. External consumers must update queries. |

---

## Tech Stack

- ODL (Ontology Definition Language — GraphQL SDL + semantic directives)
- TypeScript / Node.js 22 — `packages/sync/`, `packages/api/`, `packages/odl/`
- PostgreSQL 17 + Apache AGE — storage backend
- Docker Compose — deployment stack
- Vitest — TypeScript tests
- pnpm — monorepo package manager

---

## Commands

```
Build:    pnpm run build
Test:     pnpm --filter @openfoundry/sync test (302+ tests)
Typecheck: pnpm --filter @openfoundry/api build (tsc)
Dev:      docker compose up -d && pnpm run dev
Clean DB: docker compose down -v && docker compose up -d
Lint:     pnpm run lint
```

---

## Naming Convention

| Current (Generic) | New (Domain-Prefixed) | Rationale |
|-------------------|----------------------|-----------|
| `Person` (osint) | `IntelSubject` | "Subject" is the standard intel community term for an individual being tracked/investigated |
| `Organization` (osint) | `IntelOrganization` | Distinguishes from NHS Organization (trust/hospital entity), AML Organization (bank/financial institution) |
| `Location` (osint) | `IntelLocation` | Distinguishes from NHS Location (ward/building), Supply Chain Location (warehouse/facility) |
| `Equipment` (osint) | `IntelEquipment` | Distinguishes from NHS Equipment (medical devices), supply chain Equipment (material handling) |
| `Event` (osint) | `IntelEvent` | Distinguishes from generic system events — this is specifically an intelligence-tracked event |

NHS-Acute types (`Patient`, `Consultant`, `Ward`, `Bed`, `DischargeRecord`) keep their names — they are already domain-specific.

### New Core Link Types

Two new link types in `core/links.odl` connect domain extensions to canonical Person:

| Link Type | From | To | Purpose |
|-----------|------|----|---------|
| `ProfileForPerson` | `IntelSubject` | `Person` | OSINT subject is a profile of this person |
| `PatientProfileForPerson` | `Patient` | `Person` | NHS patient is a medical profile of this person |
| `ConsultantProfileForPerson` | `Consultant` | `Person` | NHS consultant is a staff profile of this person |

---

## Attribute Classification — What Moves Where

### Person → IntelSubject + core Person

**Intel-specific attributes (stay in IntelSubject)**:
- `threatLevel: ConfidenceLevel`
- `isPersonOfInterest: Boolean`
- `watchlistStatus: WatchlistStatus`
- `dossier: String`
- `role: String`
- `socialProfiles: JSON`
- `primaryOrganization` (link)
- `pastOrganizations` (link)
- `sourceProfiles` (link)
- `mentionedIn` (link)
- `involvedIn` (link)

**Core Person attributes (extract to `core/objects/person.odl`)**:
- `fullName: String!`
- `aliases: [String!]`
- `title: String`
- `nationality: Country`
- `dateOfBirth: Date`
- `dateOfDeath: Date`
- `emailAddresses: [String!]`
- `phoneNumbers: [String!]`
- `location: GeoPoint`
- `address: String`
- `lastKnownLocation: GeoPoint`
- `lastKnownLocationName: String`

### Organization → IntelOrganization + core Organization

**Intel-specific (stay)**:
- `type: OrgType`
- `unitDesignation: String`
- `unitSize: UnitSize`
- `branch: String`
- `strength: String`
- `isDesignated: Boolean`
- `designationDetails: String`
- `threatLevel: ConfidenceLevel`
- `equipmentHeld` (link), `areaOfOperations` (link), `headquarters` (link), `members` (link), `keyPersonnel` (link), `involvedIn` (link)

**Core Org (extract)**:
- `name: String!`
- `aliases: [String!]`
- `acronym: String`
- `country: Country`
- `location: GeoPoint`
- `address: String`

### Location → IntelLocation + core Location

**Intel-specific (stay)**:
- `strategicValue: String`
- `controlledBy` (link)
- `controlConfidence: ConfidenceLevel`
- `contestedBy: [String!]`
- `isMilitaryBase: Boolean`
- `baseType: String`
- `facilities: [String!]`
- `isActiveFrontline: Boolean`
- `populationEstimate: Int`
- `status: LocationStatus`
- `eventsHere` (link), `equipmentSighted` (link)

**Core Location (extract)**:
- `name: String!`
- `aliases: [String!]`
- `type: LocationType`
- `location: GeoPoint!`
- `address: String`
- `boundingBox: JSON`
- `country: Country!`
- `region: String`
- `adminDivision: String`

### Equipment → IntelEquipment + core Equipment

**Intel-specific (stay)**:
- `category: EquipmentCategory`
- `natoReportingName: String`
- `visualSignature: String`
- `identifiers: JSON`
- `capabilities: [String!]`
- `vulnerabilities: [String!]`
- `lossesConfirmed: Int`
- `lossesClaimed: Int`
- `lastLossRecorded: DateTime`
- `operators` (link), `sightings` (link), `usedInEvents` (link)

**Core Equipment (extract)**:
- `designation: String!`
- `commonName: String`
- `manufacturer: String`
- `originCountry: Country`
- `specifications: JSON`

### Event → IntelEvent (unchanged, all fields are domain-specific)

Event has no core counterpart — battles, airstrikes, protests are intelligence-domain concepts. NHS has no equivalent.

### NHS Patient → Patient + core Person

**Core Person attributes (extract from Patient)**:
- `name: String!` → mapped to core `Person.fullName`
- `dateOfBirth: Date!` → mapped to core `Person.dateOfBirth`

**NHS-specific attributes (stay in Patient)**:
- `nhsNumber: String @unique @indexed`
- `status: PatientStatus!`
- `triageCategory: TriageCategory`
- `presentingComplaint: String`
- `currentWard` (link), `currentBed` (link), `admissions` (link), `consultant` (link)

### NHS Consultant → Consultant + core Person

**Core Person attributes (extract from Consultant)**:
- `name: String!` → mapped to core `Person.fullName`

**NHS-specific attributes (stay in Consultant)**:
- `gmcNumber: String @unique @indexed`
- `specialty: String!`
- `patients` (link)

---

## Target Directory Structure

```
domain-packs/
│
├── core/
│   ├── pack.yaml
│   ├── interfaces/
│   │   └── core.odl              (Identifiable, Auditable, Locatable, Temporal)
│   ├── objects/
│   │   ├── person.odl             ← EXTRACTED from osint/schema/person.odl
│   │   ├── organization.odl       ← EXTRACTED from osint/schema/organization.odl
│   │   ├── location.odl           ← EXTRACTED from osint/schema/location.odl
│   │   └── equipment.odl          ← EXTRACTED from osint/schema/equipment.odl
│   └── links.odl                  ← SHARED link types (MentionsPerson → MentionsSubject)
│
├── osint/
│   ├── pack.yaml
│   ├── objects/
│   │   ├── intel-subject.odl      ← RENAMED from person.odl (intel attrs only)
│   │   ├── intel-organization.odl ← RENAMED from organization.odl (intel attrs only)
│   │   ├── intel-location.odl     ← RENAMED from location.odl (intel attrs only)
│   │   ├── intel-equipment.odl    ← RENAMED from equipment.odl (intel attrs only)
│   │   └── intel-event.odl        ← MOVED from schema/event.odl
│   ├── observations/
│   │   ├── intel-report.odl       ← MOVED from schema/intel-report.odl
│   │   └── source-profile.odl     ← MOVED from schema/source-profile.odl
│   ├── workflows/
│   │   ├── assessment.odl         ← MOVED from schema/assessment.odl
│   │   ├── indicator.odl          ← MOVED from schema/indicator.odl
│   │   └── narrative.odl          ← MOVED from schema/narrative.odl
│   ├── actions/                   (unchanged location)
│   │   ├── corroborate-report.yaml
│   │   ├── contradict-report.yaml
│   │   ├── flag-disinformation.yaml
│   │   ├── escalate-report.yaml
│   │   ├── geo-verify-report.yaml
│   │   ├── assign-source-credibility.yaml
│   │   └── create-assessment.yaml
│   ├── links.odl                  ← UPDATED to reference new type names
│   ├── enums.odl                  ← SOME enums moved to core
│   ├── permissions/
│   │   └── osint-roles.fga       ← UPDATED type references
│   ├── connectors/                (unchanged)
│   └── entity-extraction/
│       └── equipment-gazetteer.yaml (unchanged)
│
├── nhs-acute/
│   ├── pack.yaml                      (adds dependency: core)
│   ├── objects/
│   │   ├── patient.odl                ← MOVED + MODIFIED: links to core Person
│   │   ├── consultant.odl             ← MOVED + MODIFIED: links to core Person
│   │   ├── ward.odl                   ← MOVED from schema/ward.odl
│   │   └── bed.odl                    ← MOVED from schema/bed.odl
│   ├── observations/
│   │   └── discharge-record.odl       ← MOVED from schema/discharge-record.odl
│   ├── actions/
│   │   ├── register-patient.yaml     ← MODIFIED: creates Person + Patient
│   │   ├── admit-patient.yaml         (unchanged)
│   │   ├── transfer-ward.yaml         (unchanged)
│   │   ├── discharge-patient.yaml     (unchanged)
│   │   └── clean-bed.yaml             (unchanged)
│   ├── links.odl                      (unchanged)
│   ├── enums.odl                      (unchanged)
│   ├── permissions/                   (unchanged)
│   └── connectors/                    (unchanged)
│   │   └── bed.odl                ← MOVED from schema/bed.odl
│   ├── observations/
│   │   └── discharge-record.odl   ← MOVED from schema/discharge-record.odl
│   ├── actions/                   (unchanged)
│   ├── links.odl                  (unchanged)
│   ├── enums.odl                  (unchanged)
│   ├── permissions/
│   │   ├── nhs-roles.fga         (unchanged)
│   │   └── field-permissions.yaml (unchanged)
│   └── connectors/                (unchanged)
│
├── aml/
│   ├── pack.yaml
│   ├── objects/
│   │   ├── customer.odl           ← MOVED from schema/customer.odl
│   │   ├── account.odl            ← MOVED from schema/account.odl
│   │   └── transaction.odl        ← MOVED from schema/transaction.odl
│   ├── observations/
│   │   ├── alert.odl              ← MOVED from schema/alert.odl
│   │   └── suspicious-activity-report.odl ← MOVED
│   ├── workflows/
│   │   └── case.odl               ← MOVED from schema/case.odl
│   ├── actions/                   (unchanged)
│   ├── links.odl                  (unchanged)
│   ├── enums.odl                  (unchanged)
│   ├── permissions/               (unchanged)
│   └── connectors/                (unchanged)
│
└── supply-chain/
    ├── pack.yaml
    ├── objects/
    │   ├── product.odl            ← MOVED from schema/product.odl
    │   ├── supplier.odl           ← MOVED from schema/supplier.odl
    │   ├── facility.odl           ← MOVED from schema/facility.odl
    │   ├── purchase-order.odl     ← MOVED from schema/purchase-order.odl
    │   └── shipment.odl           ← MOVED from schema/shipment.odl
    ├── observations/
    │   └── inventory-record.odl   ← MOVED from schema/inventory-record.odl
    ├── actions/                   (unchanged)
    ├── links.odl                  (unchanged)
    ├── enums.odl                  (unchanged)
    ├── permissions/               (unchanged)
    └── connectors/                (unchanged)
```

---

## Layer Classification Rules

Every entity type in every domain pack must be classified into exactly ONE of these layers. This is enforced by directory placement.

| Layer | Directory | Contains | Decision Rule |
|-------|-----------|----------|---------------|
| **Objects** | `objects/` | Real-world entities that exist independently of any observer | "Would this exist if no one was watching?" → YES = objects/ |
| **Observations** | `observations/` | Source artifacts — records of something observed, raw data intake | "Is this a record of data received from an external source?" → YES = observations/ |
| **Workflows** | `workflows/` | Human/agent-created work products — synthesis, analysis, monitoring rules | "Is this created by an analyst/agent as output of their work?" → YES = workflows/ |
| **Actions** | `actions/` | Kinetic operations — what humans/agents DO to the ontology | Always action manifests (.yaml files) |
| **Interfaces** | `interfaces/` (core only) | Cross-cutting type capabilities shared across packs | "Does this describe a capability that multiple types implement?" → interfaces/ |

**Classification of every entity type**:

| Pack | Type | Layer | Reason |
|------|------|-------|--------|
| core | Person | objects | Real person, exists regardless |
| core | Organization | objects | Real organization, exists regardless |
| core | Location | objects | Real place, exists regardless |
| core | Equipment | objects | Real asset, exists regardless |
| core | Identifiable | interfaces | Capability shared by all types |
| osint | IntelSubject | objects | Real person being tracked |
| osint | IntelOrganization | objects | Real org being tracked |
| osint | IntelLocation | objects | Real location being tracked |
| osint | IntelEquipment | objects | Real equipment being tracked |
| osint | IntelEvent | objects | Real event that occurred |
| osint | IntelReport | observations | Raw tweet/message ingested |
| osint | SourceProfile | observations | Metadata about a data source |
| osint | Assessment | workflows | Analyst-synthesized product |
| osint | Indicator | workflows | Analyst-created monitoring rule |
| osint | Narrative | workflows | Analyst-created story synthesis |
| nhs-acute | Patient | objects | Real person receiving care |
| nhs-acute | Consultant | objects | Real doctor at the hospital |
| nhs-acute | Ward | objects | Real physical ward |
| nhs-acute | Bed | objects | Real physical bed |
| nhs-acute | DischargeRecord | observations | Record of a discharge event |
| aml | Customer | objects | Real person being monitored |
| aml | Account | objects | Real bank account |
| aml | Transaction | objects | Real financial transaction |
| aml | Alert | observations | System-generated alert |
| aml | SuspiciousActivityReport | observations | Filed regulatory report |
| aml | Case | workflows | Analyst-created investigation case |
| supply-chain | Product | objects | Real physical product |
| supply-chain | Supplier | objects | Real organization/vendor |
| supply-chain | Facility | objects | Real warehouse/factory |
| supply-chain | PurchaseOrder | objects | Real business document |
| supply-chain | Shipment | objects | Real physical shipment |
| supply-chain | InventoryRecord | observations | Snapshot/record of stock levels |

---

## Code Impact Analysis

### Files That MUST Change

#### 1. ODL Schema Files (12 files created/modified)

| File | Change |
|------|--------|
| `core/objects/person.odl` | NEW — extract core Person fields from osint/schema/person.odl |
| `core/objects/organization.odl` | NEW — extract core Org fields from osint/schema/organization.odl |
| `core/objects/location.odl` | NEW — extract core Location fields from osint/schema/location.odl |
| `core/objects/equipment.odl` | NEW — extract core Equipment fields from osint/schema/equipment.odl |
| `core/links.odl` | NEW — shared link types |
| `osint/objects/intel-subject.odl` | RENAME from schema/person.odl, remove core fields, add link to core.Person |
| `osint/objects/intel-organization.odl` | RENAME from schema/organization.odl, remove core fields |
| `osint/objects/intel-location.odl` | RENAME from schema/location.odl, remove core fields |
| `osint/objects/intel-equipment.odl` | RENAME from schema/equipment.odl, remove core fields |
| `osint/objects/intel-event.odl` | MOVE from schema/event.odl (no field changes) |
| `osint/objects/` — 3 observation types | MOVE from schema/ |
| `osint/objects/` — 3 workflow types | MOVE from schema/ |
| `osint/links.odl` | UPDATE type references: Person→IntelSubject, Organization→IntelOrganization, etc. |
| `nhs-acute/objects/` — 4 types | MOVE from schema/ |
| `nhs-acute/observations/` — 1 type | MOVE from schema/ |
| `aml/objects/` — 3 types | MOVE from schema/ |
| `aml/observations/` — 2 types | MOVE from schema/ |
| `aml/workflows/` — 1 type | MOVE from schema/ |
| `supply-chain/objects/` — 5 types | MOVE from schema/ |
| `supply-chain/observations/` — 1 type | MOVE from schema/ |

#### 2. TypeScript source files

| File | Line(s) | Change | Why |
|------|---------|--------|-----|
| `packages/sync/src/entity-extraction/entity-extraction-service.ts` | 169-237 | **Dual creates** in `createEntity()` | Create core Person + IntelSubject per Person entity. Create core Organization + IntelOrganization per Org entity. etc. |
| `packages/sync/src/entity-extraction/entity-extraction-service.ts` | 241-253 | Update `linkTypeFor()` mappings | Link types may be renamed (TBD) |
| `packages/sync/src/entity-extraction/entity-dedup.ts` | 197-205 | Update `tableNameFor()` mappings | New table names: `person` (core), `intel_subject` (extension), `patient` (NHS) |
| `packages/sync/src/entity-extraction/entity-dedup.ts` | 77-147 | Update `batchResolve()` SQL | Table name references in queries — use core `person._normalized_name` |
| `packages/sync/src/entity-extraction/entity-dedup.ts` | 17-54 | Update `resolve()` SQL | Query `person._normalized_name` for dedup |
| `packages/api/src/bootstrap/ner-bootstrap.ts` | 31-35 | NER labels unchanged | Labels are extraction model output, not ODL types |
| `tools/backfill-normalized-names.ts` | 29-32 | Add core person table | New row: `{ table: 'person', nameField: 'full_name', type: 'Person' }` |

#### 2b. createEntity() Dual-Create Pattern — Before/After

```typescript
// ── BEFORE (Phase 0): Single create, all fields inline ──
case 'Person': {
  const created = await this.objectManager.create('Person', {
    ...base,
    fullName: entity.name,
    _normalizedName: normalizedName,
    watchlistStatus: 'NONE',          // intel field on Person type
    isPersonOfInterest: false,        // intel field on Person type
  }, ctx);
  return created._id;
}

// ── AFTER (Phase 1): Dual create — core Person + IntelSubject ──
case 'Person': {
  // Step 1: Create canonical Person (core)
  const person = await this.objectManager.create('Person', {
    ...base,
    fullName: entity.name,
    _normalizedName: normalizedName,
  }, ctx);

  // Step 2: Create intel extension (linked to Person)
  const subject = await this.objectManager.create('IntelSubject', {
    ...base,
    person: person._id,              // ← LINK to core Person
    watchlistStatus: 'NONE',
    isPersonOfInterest: false,
  }, ctx);

  // Return IntelSubject._id — the caller creates MentiosSubject links
  // (IntelReport → IntelSubject), so the target must be the extension ID.
  return subject._id;
}
```
```typescript
// Same pattern for other entity types:
// Organization → core Organization + IntelOrganization, return intelOrg._id
// Location      → core Location + IntelLocation, return intelLoc._id
// Equipment     → core Equipment + IntelEquipment, return intelEq._id
// Event         → IntelEvent only (single create), return event._id
// Event         → IntelEvent only (no core counterpart)
```

#### 2c. NHS register-patient Action — Before/After

```yaml
# ── BEFORE: Single create, name + dob inline ──
effects:
  - type: createObject
    objectType: "Patient"
    properties:
      name: "params.name"
      dateOfBirth: "params.dateOfBirth"
      nhsNumber: "params.nhsNumber"
      status: "DISCHARGED"

# ── AFTER: Dual create — core Person + Patient ──
# The action executor injects each created object into the resolution context
# using the camelCase type name as the key (Person → "person").
# So "person._id" references the Person created in the preceding effect.
# See: packages/actions/src/executor/action-executor.ts:796-802
effects:
  - type: createObject
    objectType: "Person"
    properties:
      fullName: "params.name"         # ← mapped: Patient.name → Person.fullName
      dateOfBirth: "params.dateOfBirth"

  - type: createObject
    objectType: "Patient"
    properties:
      person: "person._id"            # ← LINK to the Person just created
      nhsNumber: "params.nhsNumber"
      status: "DISCHARGED"
      triageCategory: "params.triageCategory"
```

#### 3. Link type definitions (osint/links.odl)

All link types referencing the old type names must be updated:

```
MentionsPerson      → from: "IntelReport", to: "IntelSubject"
MentionsOrganization → from: "IntelReport", to: "IntelOrganization"
MentionsLocation    → from: "IntelReport", to: "IntelLocation"
MentionsEquipment   → from: "IntelReport", to: "IntelEquipment"
PersonBelongsToOrg  → from: "IntelSubject", to: "IntelOrganization"
...
```

Every link type containing `"Person"`, `"Organization"`, `"Location"`, or `"Equipment"` in its `from` or `to` must be updated. There are approximately 30 such link types in `osint/links.odl`.

#### 4. OpenFGA model

`domain-packs/osint/permissions/osint-roles.fga` — type references must be updated:
```
type person → type intel_subject
type organization → type intel_organization
```

#### 5. NHS-Acute field changes

NHS Patient and Consultant are **modified**:
- `name: String!` → removed (replaced by link to core Person.fullName)
- `dateOfBirth: Date!` → removed (replaced by link to core Person.dateOfBirth)
- `person: Person! @link(type: "PatientProfileForPerson")` → ADDED (link to core Person)
- All other NHS-specific fields (nhsNumber, status, triageCategory, gmcNumber, specialty) → unchanged

```odl
# nhs-acute/objects/patient.odl — AFTER
type Patient implements Identifiable & Auditable {
  id: ID! @primary
  person: Person! @link(type: "PatientProfileForPerson", direction: OUTBOUND)
  nhsNumber: String @unique @indexed
  status: PatientStatus!
  triageCategory: TriageCategory
  presentingComplaint: String
  currentWard: Ward @link(type: "AdmittedTo", direction: OUTBOUND)
  currentBed: Bed @link(type: "OccupiesBed", direction: OUTBOUND)
  admissions: [AdmittedTo!]! @link(type: "AdmittedTo", direction: OUTBOUND, history: true)
  consultant: Consultant @link(type: "UnderCareOf", direction: OUTBOUND)
}

# nhs-acute/objects/consultant.odl — AFTER
type Consultant implements Identifiable & Auditable {
  id: ID! @primary
  person: Person! @link(type: "ConsultantProfileForPerson", direction: OUTBOUND)
  gmcNumber: String @unique @indexed
  specialty: String!
  patients: [Patient!]! @link(type: "UnderCareOf", direction: INBOUND)
}
```

#### 5b. NHS register-patient action — Resolved

The action executor supports cross-effect references. Each `createObject` effect injects the created object into the resolution context using the **camelCase type name** as the key (`"Person"` → `"person"`, `"Patient"` → `"patient"`). See `packages/actions/src/executor/action-executor.ts:796-802`. A subsequent effect can reference `"person._id"` to link to the previously created core Person.

**Caveat**: The context key is first-create-wins — if two `Person` creates appear in the same action, only the first is stored. For register-patient (single Person create), this is fine.

```yaml
# nhs-acute/actions/register-patient.yaml — AFTER
effects:
  - type: createObject
    objectType: "Person"
    properties:
      fullName: "params.name"
      dateOfBirth: "params.dateOfBirth"
  
  - type: createObject
    objectType: "Patient"
    properties:
      person: "person._id"              # Linked via camelCase type name
      nhsNumber: "params.nhsNumber"
      status: "DISCHARGED"
      triageCategory: "params.triageCategory"
```

#### 6. Pack manifests (pack.yaml)

Update `domain-packs/core/pack.yaml` to include the new object/link type declarations.
Update `domain-packs/osint/pack.yaml` dependency to include `core`.

#### 7. Schema loader (if path-dependent)

The schema loader at `packages/api/src/schema-loader.ts` may need path updates if it hardcodes `schema/` as the schema directory. More likely, it recursively discovers `.odl` files — in which case, moving files into subdirectories is transparent.

### Files That Do NOT Change

- **NER pipeline**: Labels (`Person`, `Organization`) are unchanged — they're model output strings
- **Python gRPC service**: Operates on text, not ODL types
- **Twitter connector**: Ingests tweets into IntelReport — type-agnostic
- **Action manifests**: Operate on IntelReport/Assessment, not directly on renamed types
- **GraphQL/REST codegen**: Schema-driven, auto-adapts
- **Enums (enums.odl)**: Some enums may need relocation but no field changes
- **Docker Compose**: Unchanged (services unaffected)
- **CEP/CDC/Connector infrastructure**: Type-agnostic

---

## Testing Strategy

### Pre-migration tests (confirm baseline)
```
pnpm --filter @openfoundry/sync test   # 302 tests must pass
pnpm --filter @openfoundry/odl test     # ODL compilation tests
pnpm run build                          # All packages
```

### Post-migration tests (confirm no regressions)
- Same as pre-migration — 302+ tests must pass
- Manual: Start docker compose, verify entities are created via NER, verify querying via GraphQL returns renamed types
- Integration: Verify `ExtractEntities` gRPC call still works (labels unchanged)

### Test updates required
The following test files reference the old type names as strings and must be updated:

| File | Approximate Changes |
|------|-------------------|
| `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts` | ~5 string replacements |
| `packages/sync/src/entity-extraction/__tests__/entity-dedup.test.ts` | ~10 string replacements |
| `packages/sync/src/entity-extraction/__tests__/entity-validation.test.ts` | ~8 string replacements |
| `domain-packs/osint/src/__tests__/osint-pack.test.ts` | ~5 string replacements + field assertions |

Tests should continue asserting the SAME behavior — they just use the new type names. For example:

```typescript
// BEFORE:
{ type: 'Person', name: 'Zelensky', confidence: 0.9 }

// AFTER:
{ type: 'Person', name: 'Zelensky', confidence: 0.9 }  // ← NER label unchanged!
// But createEntity() calls objectManager.create('IntelSubject', ...)
```

---

## Boundaries

### Always do
- Run `pnpm test` after every file change
- Run `docker compose down -v && docker compose up -d` after schema changes (checksum reset)
- Keep NER labels unchanged (`Person`, `Organization`, `Location`, `Equipment`)
- Keep `_normalizedName` logic consistent across old and new type mappings
- Log every change to `docs/log.md`

### Ask first
- Adding new interfaces beyond the 3 defined (Identifiable, Auditable, Locatable)
- Changing the layer classification of any entity type
- Modifying the NHS-Acute pack beyond directory reorganization
- Adding database migration scripts beyond schema auto-generation
- Changing pack loading order

### Never do
- Remove core fields from ODL before extracting them to core/ — always extract first, then remove
- Change NER labels
- Modify entity extraction behavior (the pipeline should produce identical results post-refactor)
- Merge two domain packs' schema directories
- Hardcode new type names in connector YAML (connectors reference entities by data model, not domain pack types)

---

## Success Criteria

- [ ] `core/objects/person.odl` exists with canonical Person attributes (fullName, aliases, dateOfBirth, nationality, contact info, location)
- [ ] `core/objects/organization.odl` exists with canonical Organization attributes
- [ ] `core/objects/location.odl` exists with canonical Location attributes
- [ ] `core/objects/equipment.odl` exists with canonical Equipment attributes
- [ ] `core/links.odl` defines `ProfileForPerson`, `PatientProfileForPerson`, `ConsultantProfileForPerson` (shared link types)
- [ ] `osint/objects/intel-subject.odl` links to core Person + intel-specific attributes
- [ ] `nhs-acute/objects/patient.odl` links to core Person + NHS-specific attributes (name/DoB removed)
- [ ] `nhs-acute/objects/consultant.odl` links to core Person + consultant-specific attributes (name removed)
- [ ] Same linked-extension pattern for Organization, Location, Equipment across core + osint
- [ ] All osint types moved into `objects/`, `observations/`, `workflows/` subdirectories
- [ ] All nhs-acute types moved into `objects/`, `observations/` subdirectories
- [ ] All aml types moved into `objects/`, `observations/`, `workflows/` subdirectories
- [ ] All supply-chain types moved into `objects/`, `observations/` subdirectories
- [ ] All 30+ link types in `osint/links.odl` updated to new type names
- [ ] `pnpm --filter @openfoundry/sync test` — 302+ tests pass with updated type names
- [ ] `pnpm run build` — all packages compile
- [ ] `docker compose down -v && docker compose up -d` — stack starts clean
- [ ] **`createEntity()` does DUAL creates**: core Person + IntelSubject per extracted Person entity
- [ ] **NHS `register-patient` action does DUAL creates**: core Person + Patient
- [ ] `tableNameFor()` dedup queries target `person._normalized_name` (canonical name)
- [ ] GraphQL schema reflects linked-type structure (querying Person returns linked Patient/IntelSubject)

---

## Open Questions

1. **Action executor cross-effect references**: ~~Blocking — does `lastCreated.id` work?~~ **RESOLVED.** The executor uses camelCase type name as context key (`"Person"` → `"person"`). Reference as `"person._id"`. First-create-wins for duplicate type creates (`action-executor.ts:796-802`).

2. **Link type renaming**: Should `MentionsPerson` be renamed to `MentionsSubject`? **Recommendation**: Keep unchanged. Only update `from`/`to` references.

3. **`_normalizedName` dedup target**: Dedup should query `person._normalized_name` (core table). Both `batchResolve()` and `resolve()` in `entity-dedup.ts` need updating.

4. **Pack loading order**: Core must load first. Add dependency declarations in `pack.yaml`.

5. **Existing data backfill**: Patients created before this refactor have `name`/`dateOfBirth` inline. Backfill script needed to create core Person records and link them. **Follow-up task.**

---
