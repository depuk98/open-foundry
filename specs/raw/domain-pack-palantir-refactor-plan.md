# Implementation Plan: Domain Pack Palantir Refactor

## Overview

Restructure all 5 domain packs into a 4-layer architecture following Palantir's design principles. Extract canonical entity types (Person, Organization, Location, Equipment) from `osint/schema/` into a shared `core/objects/` pack. Rename OSINT types with domain prefixes. Convert NHS-Acute Patient and Consultant to link to core Person via dual creates. Apply same pattern to OSINT IntelSubject, IntelOrganization, IntelLocation, IntelEquipment. Reorganize all packs into `objects/`, `observations/`, `workflows/` subdirectories.

**23 tasks across 4 phases. 12 new files, 18 modified, 12 deleted. ~45 files total touched.**

---

## Architecture Decisions

- **Dual records from Phase 1**: Both NHS Patient and OSINT IntelSubject link to a shared core Person. No deferred extraction.
- **CamelCase context key**: Action executor injects created objects as `context.person`, `context.patient` (type name lowercased). Cross-effect references use `"person._id"`.
- **First-create-wins for context**: If two `Person` creates happen in one action, only the first ID is stored. Not an issue for current manifests (single Person create each).
- **Dedup targets `person._normalized_name`**: Canonical Person table is the single source of truth for name dedup.
- **Link type names unchanged**: `MentionsPerson` stays. Only `from`/`to` type references are updated.
- **NHS fields removed**: `Patient.name` → `Patient` links to `Person.fullName`, `Patient.dateOfBirth` → `Person.dateOfBirth`. Fields removed from Patient ODL.
- **`docker compose down -v`**: Schema checksums change. Volume wipe is the cleanest path for development.

---

## Dependency Graph

```
Phase 1: Foundation (2 tasks, sequential)
  A. Create core ODL (Person, Organization, Location, Equipment)
  B. Create core link types + update core pack.yaml
         │
         ▼
Phase 2: Domain Pack Schema Changes (10 tasks, parallel by pack)
  ┌─ NHS pack ──────────────────────┐   ┌─ OSINT pack ────────────────────┐
  │ C. NHS Patient ODL update       │   │ F. IntelSubject ODL (new)        │
  │ D. NHS Consultant ODL update    │   │ G. IntelOrganization ODL (new)   │
  │ E. NHS register-patient update  │   │ H. IntelLocation ODL (new)       │
  └─────────────────────────────────┘   │ I. IntelEquipment ODL (new)      │
                                        │ J. IntelEvent rename             │
                                        │ K. Observation types move        │
  ┌─ AML + Supply Chain ────────────┐   │ L. Workflow types move           │
  │ N. AML directory reorganization │   │ M. OSINT link types update       │
  │ O. Supply Chain dir reorg       │   └─────────────────────────────────┘
  └─────────────────────────────────┘
         │
         ▼
Phase 3: Code Changes (6 tasks, sequential within subsystems)
  P. entity-extraction-service.ts (dual creates)
  Q. entity-dedup.ts (table mappings + dedup target)
  R. backfill-normalized-names.ts update
  S. OpenFGA model + test updates
         │
         ▼
Phase 4: Verification (2 tasks)
  T. docker compose down -v && up -d (clean DB)
  U. Full test suite + build verification

Checkpoint: 16 tasks, 4 phases, all tests pass
```

---

## Task List

### Phase 1: Foundation (Core Pack)

---

#### Task A: Create core entity ODL files

**Description:** Create `core/objects/person.odl`, `core/objects/organization.odl`, `core/objects/location.odl`, `core/objects/equipment.odl`. Extract only the canonical (non-intel) attributes from the existing `osint/schema/` files. Each type implements `Identifiable & Auditable` and includes `_normalizedName` for dedup.

**Person canonical attributes**: fullName, aliases, title, nationality, dateOfBirth, dateOfDeath, emailAddresses, phoneNumbers, location, address, lastKnownLocation, lastKnownLocationName, _normalizedName.

**Organization canonical attributes**: name, aliases, acronym, country, location, address, _normalizedName.

**Location canonical attributes**: name, aliases, country, region, adminDivision, location (GeoPoint), address, boundingBox, _normalizedName.

**Equipment canonical attributes**: designation, commonName, manufacturer, originCountry, specifications, _normalizedName.

**Acceptance criteria:**
- [ ] `core/objects/person.odl` exists with ~16 canonical fields, no intel fields (threatLevel, watchlistStatus, etc.)
- [ ] `core/objects/organization.odl` exists with ~7 canonical fields, no intel fields (type, isDesignated, etc.)
- [ ] `core/objects/location.odl` exists with ~9 canonical fields, no intel fields (strategicValue, isMilitaryBase, etc.)
- [ ] `core/objects/equipment.odl` exists with ~6 canonical fields, no intel fields (category, capabilities, etc.)
- [ ] All 4 types declare `_normalizedName: String @indexed` (OPTIONAL — `String` not `String!`. NHS creates core Person without `_normalizedName`. OSINT always populates it. Dedup uses partial index: `WHERE _normalized_name IS NOT NULL`.)
- [ ] `core/interfaces/core.odl` remains unchanged

**Verification:**
- [ ] ODL compilation succeeds
- [ ] Files are syntactically valid (no missing commas, correct directive syntax)

**Dependencies:** None

**Files likely touched:**
- `domain-packs/core/objects/person.odl` (NEW)
- `domain-packs/core/objects/organization.odl` (NEW)
- `domain-packs/core/objects/location.odl` (NEW)
- `domain-packs/core/objects/equipment.odl` (NEW)

**Estimated scope:** M (4 files)

---

#### Task B: Create core link types + update core pack.yaml

**Description:** Create `core/links.odl` with shared link types that connect domain extensions to canonical entities. Update `core/pack.yaml` to declare the new object types and link types.

**Link types to create:**
1. `ProfileForPerson @linkType(from: "IntelSubject", to: "Person")` — OSINT subject links to Person
2. `PatientProfileForPerson @linkType(from: "Patient", to: "Person")` — NHS patient links to Person
3. `ConsultantProfileForPerson @linkType(from: "Consultant", to: "Person")` — NHS consultant links to Person

**Acceptance criteria:**
- [ ] `core/links.odl` exists with 3 link types
- [ ] `core/pack.yaml` updated with object type and link type declarations
- [ ] Link types reference correct `from`/`to` type names

**Verification:**
- [ ] ODL compilation succeeds

**Dependencies:** Task A

**Files likely touched:**
- `domain-packs/core/links.odl` (NEW)
- `domain-packs/core/pack.yaml`

**Estimated scope:** S (2 files)

---

### Checkpoint: Phase 1
- [ ] Core pack has canonical Person, Organization, Location, Equipment + shared links
- [ ] ODL files compile

---

### Phase 2: Domain Pack Schema Changes

---

#### Task C: Update NHS Patient ODL

**Description:** Modify `nhs-acute/objects/patient.odl`. Remove `name` and `dateOfBirth` fields. Add `person: Person! @link(type: "PatientProfileForPerson", direction: OUTBOUND)`. Patient now links to core Person for all person-identity attributes.

**Acceptance criteria:**
- [ ] `name` field removed from Patient
- [ ] `dateOfBirth` field removed from Patient
- [ ] `person: Person! @link(type: "PatientProfileForPerson", direction: OUTBOUND)` added
- [ ] All other NHS-specific fields (nhsNumber, status, triageCategory, currentWard, currentBed, admissions, consultant) unchanged
- [ ] File moved to `nhs-acute/objects/patient.odl`

**Verification:**
- [ ] ODL compilation succeeds
- [ ] Existing NHS tests still compile (field removals may break test assertions — fix in Task S)

**Dependencies:** Task B (link types must exist)

**Files likely touched:**
- `domain-packs/nhs-acute/objects/patient.odl` (MOVE + MODIFY)

**Estimated scope:** S (1 file move + modify)

---

#### Task D: Update NHS Consultant ODL

**Description:** Same pattern as Patient. Remove `name` field. Add `person: Person! @link(type: "ConsultantProfileForPerson", direction: OUTBOUND)`. Move to `objects/`.

**Acceptance criteria:**
- [ ] `name` field removed from Consultant
- [ ] `person: Person! @link(type: "ConsultantProfileForPerson", direction: OUTBOUND)` added
- [ ] gmcNumber, specialty, patients links unchanged
- [ ] File moved to `nhs-acute/objects/consultant.odl`

**Verification:**
- [ ] ODL compilation succeeds

**Dependencies:** Task B

**Files likely touched:**
- `domain-packs/nhs-acute/objects/consultant.odl` (MOVE + MODIFY)

**Estimated scope:** XS (1 file)

---

#### Task E: Update NHS register-patient.yaml

**Description:** Modify the register-patient action to dual-create: first create core Person, then create Patient linked to it. Use `"person._id"` to reference the created Person.

**Acceptance criteria:**
- [ ] `effects[0]` creates `Person` with `fullName` and `dateOfBirth`
- [ ] `effects[1]` creates `Patient` with `person: "person._id"` and NHS-specific fields
- [ ] Consent effect unchanged
- [ ] Side effects unchanged
- [ ] Preconditions unchanged

**Verification:**
- [ ] YAML parses without errors
- [ ] Action manifest validation passes

**Dependencies:** Task C (Patient ODL must exist)

**Files likely touched:**
- `domain-packs/nhs-acute/actions/register-patient.yaml`

**Estimated scope:** S (1 file)

---

#### Task F: Create IntelSubject ODL

**Description:** Create `osint/objects/intel-subject.odl` from the intel-specific fields currently in `person.odl`. Remove core Person fields that moved to `core/objects/person.odl`. Add `person: Person! @link(type: "ProfileForPerson", direction: OUTBOUND)`. The old `osint/schema/person.odl` is deleted.

**IntelSubject attributes (domain-specific)**: threatLevel, isPersonOfInterest, watchlistStatus, dossier, role, socialProfiles, primaryOrganization (link), pastOrganizations (link), sourceProfiles (link), mentionedIn (link), involvedIn (link).

**Acceptance criteria:**
- [ ] `osint/objects/intel-subject.odl` exists
- [ ] Links to core Person via `ProfileForPerson`
- [ ] Contains ONLY intel-specific attributes (no fullName, no aliases, no dateOfBirth, no nationality, no contact info, no location fields)
- [ ] Original `osint/schema/person.odl` deleted

**Verification:**
- [ ] ODL compilation succeeds
- [ ] No `fullName` or `dateOfBirth` fields in IntelSubject

**Dependencies:** Task B (link type must exist)

**Files likely touched:**
- `domain-packs/osint/objects/intel-subject.odl` (NEW)
- `domain-packs/osint/schema/person.odl` (DELETE)

**Estimated scope:** M (2 files)

---

#### Task G: Create IntelOrganization, IntelLocation, IntelEquipment ODLs

**Description:** Same pattern. Extract intel-specific fields into new domain-prefixed ODL files. Remove core fields that moved to `core/objects/`. All link to canonical core types. Delete old `schema/` files.

**IntelOrganization**: type, unitDesignation, unitSize, branch, strength, isDesignated, designationDetails, threatLevel + all domain-specific links. Link to core Organization via new link type `OrgProfileForOrganization` (add to core/links.odl).

**IntelLocation**: strategicValue, controlledBy, controlConfidence, contestedBy, isMilitaryBase, baseType, facilities, isActiveFrontline, populationEstimate, status + links. Link to core Location via `LocationProfileForLocation`.

**IntelEquipment**: category, natoReportingName, visualSignature, identifiers, capabilities, vulnerabilities, lossesConfirmed, lossesClaimed, lastLossRecorded + links. Link to core Equipment via `EquipmentProfileForEquipment`.

**Acceptance criteria:**
- [ ] 3 new ODL files in `osint/objects/`
- [ ] 3 old files in `osint/schema/` deleted
- [ ] 3 new link types added to `core/links.odl`
- [ ] All core fields (name/designation, country, coordinates, etc.) absent from domain files

**Verification:**
- [ ] ODL compilation succeeds

**Dependencies:** Tasks A, B

**Files likely touched:**
- `domain-packs/osint/objects/intel-organization.odl` (NEW)
- `domain-packs/osint/objects/intel-location.odl` (NEW)
- `domain-packs/osint/objects/intel-equipment.odl` (NEW)
- `domain-packs/core/links.odl` (MODIFY — add 3 link types)
- `domain-packs/osint/schema/organization.odl` (DELETE)
- `domain-packs/osint/schema/location.odl` (DELETE)
- `domain-packs/osint/schema/equipment.odl` (DELETE)

**Estimated scope:** L (7 files)

---

#### Task H: Rename IntelEvent + move to objects/

**Description:** Move `osint/schema/event.odl` to `osint/objects/intel-event.odl`. Update the type name from `Event` to `IntelEvent`. No core counterpart exists — Event is entirely domain-specific. Update all `@link` references from `Event` to `IntelEvent` within the file.

**Acceptance criteria:**
- [ ] `osint/objects/intel-event.odl` exists
- [ ] Type renamed to `IntelEvent`
- [ ] Internal link references (`participants: [Person!]!` → `participants: [IntelSubject!]!` etc.) updated
- [ ] Original `osint/schema/event.odl` deleted

**Verification:**
- [ ] ODL compilation succeeds

**Dependencies:** Tasks F, G (IntelSubject, IntelOrganization, IntelLocation, IntelEquipment must exist for link references)

**Files likely touched:**
- `domain-packs/osint/objects/intel-event.odl` (NEW)
- `domain-packs/osint/schema/event.odl` (DELETE)

**Estimated scope:** M (2 files)

---

#### Task I: Move OSINT observation types to observations/

**Description:** Move `intel-report.odl`, `source-profile.odl` from `schema/` to `observations/`. No field changes. Update internal type references (`Person` → `IntelSubject`, `Organization` → `IntelOrganization`, etc. within these files).

**Acceptance criteria:**
- [ ] `osint/observations/intel-report.odl` exists with updated type references
- [ ] `osint/observations/source-profile.odl` exists with updated type references
- [ ] Old files deleted from `schema/`

**Verification:**
- [ ] ODL compilation succeeds

**Dependencies:** Tasks F, G, H

**Files likely touched:**
- `domain-packs/osint/observations/intel-report.odl` (MOVE + MODIFY)
- `domain-packs/osint/observations/source-profile.odl` (MOVE + MODIFY)
- `domain-packs/osint/schema/intel-report.odl` (DELETE)
- `domain-packs/osint/schema/source-profile.odl` (DELETE)

**Estimated scope:** S (4 files)

---

#### Task J: Move OSINT workflow types to workflows/

**Description:** Move `assessment.odl`, `indicator.odl`, `narrative.odl` from `schema/` to `workflows/`. Update internal type references.

**Acceptance criteria:**
- [ ] 3 files in `osint/workflows/` with updated type references
- [ ] 3 old files deleted from `schema/`

**Verification:**
- [ ] ODL compilation succeeds

**Dependencies:** Tasks F, G, H

**Files likely touched:**
- `domain-packs/osint/workflows/assessment.odl` (MOVE + MODIFY)
- `domain-packs/osint/workflows/indicator.odl` (MOVE + MODIFY)
- `domain-packs/osint/workflows/narrative.odl` (MOVE + MODIFY)
- 3 delete operations

**Estimated scope:** S (6 files)

---

#### Task K: Update OSINT link types

**Description:** Update `osint/links.odl`. All types referencing `Person`, `Organization`, `Location`, `Equipment`, `Event` must be updated to the new domain-prefixed names. This is approximately 30 link type definitions.

**Mapping:**
```
from/to "Person"       → "IntelSubject"
from/to "Organization" → "IntelOrganization"
from/to "Location"     → "IntelLocation"
from/to "Equipment"    → "IntelEquipment"
from/to "Event"        → "IntelEvent"
```

**Acceptance criteria:**
- [ ] All ~30 link type definitions updated
- [ ] No remaining references to old type names `Person`, `Organization`, `Location`, `Equipment`, `Event`
- [ ] ODL compilation succeeds

**Verification:**
- [ ] `rg '(from|to):\s*"(Person|Organization|Location|Equipment|Event)"' domain-packs/osint/links.odl` — zero matches

**Dependencies:** Tasks F, G, H, I, J

**Files likely touched:**
- `domain-packs/osint/links.odl`

**Estimated scope:** M (1 file, ~30 replacements)

---

#### Task L: Reorganize NHS-Acute remaining types

**Description:** Move non-modified NHS types into `objects/` and `observations/` subdirectories. No field changes for Ward, Bed, DischargeRecord — just move.

**Acceptance criteria:**
- [ ] `nhs-acute/objects/ward.odl` (moved)
- [ ] `nhs-acute/objects/bed.odl` (moved)
- [ ] `nhs-acute/observations/discharge-record.odl` (moved)
- [ ] Old files deleted from `schema/`
- [ ] `nhs-acute/links.odl`, `enums.odl` stay in `nhs-acute/`

**Verification:**
- [ ] ODL compilation succeeds

**Dependencies:** None (independent)

**Files likely touched:**
- 3 moves + 3 deletes

**Estimated scope:** XS (6 file operations)

---

#### Task M: Reorganize AML types

**Description:** Move AML types into `objects/`, `observations/`, `workflows/` subdirectories.

**Classification:**
- `objects/`: customer.odl, account.odl, transaction.odl
- `observations/`: alert.odl, suspicious-activity-report.odl
- `workflows/`: case.odl
- Keep: `links.odl`, `enums.odl`, `actions/`, `permissions/`, `connectors/`

**Acceptance criteria:**
- [ ] 6 files moved, 6 deleted from `schema/`
- [ ] ODL compilation succeeds

**Dependencies:** None

**Files likely touched:**
- 6 moves + 6 deletes

**Estimated scope:** XS (12 file operations)

---

#### Task N: Reorganize Supply-Chain types

**Description:** Move supply-chain types into `objects/` and `observations/`.

**Classification:**
- `objects/`: product.odl, supplier.odl, facility.odl, purchase-order.odl, shipment.odl
- `observations/`: inventory-record.odl

**Acceptance criteria:**
- [ ] 6 files moved, 6 deleted from `schema/`
- [ ] ODL compilation succeeds

**Dependencies:** None

**Files likely touched:**
- 6 moves + 6 deletes

**Estimated scope:** XS (12 file operations)

---

#### Task N2: Verify pack loader discovers subdirectories

**Description:** Before implementing directory restructuring, verify that the pack loader at `packages/api/src/schema-loader.ts` recursively discovers `.odl` files in subdirectories (not just `schema/`). If it hardcodes the `schema/` path, it must be updated to scan `objects/`, `observations/`, `workflows/` in addition to (or instead of) `schema/`.

**Acceptance criteria:**
- [ ] Pack loader discovers `.odl` files in `objects/` subdirectory
- [ ] Pack loader discovers `.odl` files in `observations/` subdirectory
- [ ] Pack loader discovers `.odl` files in `workflows/` subdirectory
- [ ] Pack loader still discovers `.odl` files in legacy `schema/` for packs not yet restructured

**Verification:**
- [ ] Start server with restructured packs → all types load without errors

**Dependencies:** None (prerequisite before Phase 2 file moves)

**Files likely touched:**
- `packages/api/src/schema-loader.ts` (READ + POTENTIAL MODIFY)

**Estimated scope:** S (1 file read + potentially modify)

---

#### Task N3: Update NHS pack.yaml

**Description:** Update `domain-packs/nhs-acute/pack.yaml` to declare the new directory structure and add a dependency on `core` for the shared Person type and link types.

**Acceptance criteria:**
- [ ] `pack.yaml` declares dependency on `core` pack
- [ ] `pack.yaml` lists new object type paths (`objects/patient.odl`, `objects/consultant.odl`, etc.)
- [ ] `pack.yaml` lists new observation type path (`observations/discharge-record.odl`)

**Verification:**
- [ ] Pack loader loads NHS pack without errors

**Dependencies:** Tasks C, D, L

**Files likely touched:**
- `domain-packs/nhs-acute/pack.yaml`

**Estimated scope:** XS (1 file)

---

#### Task N4: Verify OSINT enums.odl + actions.odl

**Description:** Read `osint/schema/enums.odl` and `osint/schema/actions.odl`. Check if they contain any hardcoded references to entity type names (`Person`, `Organization`, `Location`, `Equipment`, `Event`). Enums are value sets — unlikely to reference entity types directly. Actions definitions reference action types, not object types. Still, verify before finalizing.

**Acceptance criteria:**
- [ ] `enums.odl` contains no references to old entity type names (or references are updated)
- [ ] `actions.odl` contains no references to old entity type names (or references are updated)
- [ ] Both files moved to `osint/` root (next to `links.odl`)

**Verification:**
- [ ] `rg "Person|Organization|Location|Equipment|Event" domain-packs/osint/enums.odl` — no unexpected matches
- [ ] `rg "Person|Organization|Location|Equipment|Event" domain-packs/osint/actions.odl` — no unexpected matches

**Dependencies:** Tasks F, G, H

**Files likely touched:**
- `domain-packs/osint/enums.odl` (READ + POTENTIAL MODIFY + MOVE)
- `domain-packs/osint/actions.odl` (READ + POTENTIAL MODIFY + MOVE)

**Estimated scope:** S (2 files read + potentially modify + move)

---

### Checkpoint: Phase 2
- [ ] All 5 domain packs restructured into layered directories
- [ ] Core entity types extracted
- [ ] OSINT types renamed
- [ ] NHS Patient + Consultant link to core Person
- [ ] All link types updated
- [ ] ODL compiles for all packs

---

### Phase 3: Code Changes

---

#### Task O: Update entity-extraction-service.ts (dual creates)

**Description:** Modify `createEntity()` to perform dual creates for Person/Organization/Location/Equipment. First create the canonical core entity, then create the domain extension linked to it. Event creates only `IntelEvent` (no core counterpart).

**Before:**
```typescript
case 'Person':
  const created = await objectManager.create('Person', { ... });
```

**After:**
```typescript
case 'Person':
  const person = await objectManager.create('Person', { fullName, _normalizedName, ...base });
  const subject = await objectManager.create('IntelSubject', { person: person._id, watchlistStatus: 'NONE', ...base });
  return subject._id;  // ← extension ID, caller uses it for MentiosSubject links
```

**Acceptance criteria:**
- [ ] `case 'Person'` creates core Person + IntelSubject, **returns IntelSubject._id** (caller creates MentiosSubject links → needs extension ID, not core ID)
- [ ] `case 'Organization' / 'MilitaryUnit'` creates core Organization + IntelOrganization, **returns IntelOrganization._id**
- [ ] `case 'ArmedGroup'` creates core Organization + IntelOrganization (with ARMED_GROUP type), **returns IntelOrganization._id**
- [ ] `case 'Location' / 'ConflictZone'` creates core Location + IntelLocation, **returns IntelLocation._id**
- [ ] `case 'Equipment' / 'WeaponSystem'` creates core Equipment + IntelEquipment, **returns IntelEquipment._id**
- [ ] `case 'Event'` creates IntelEvent only (single create), returns event._id
- [ ] `case default` returns null unchanged
- [ ] `linkTypeFor()` mapping unchanged (link type names remain the same)
- [ ] Dedup cache stores extension ID via `set()` — dedup resolution returns extension ID for correct link targets

**Verification:**
- [ ] `pnpm --filter @openfoundry/sync test` — all entity-extraction-service tests pass

**Dependencies:** Tasks F, G (IntelSubject, IntelOrganization, etc. must exist in ODL)

**Files likely touched:**
- `packages/sync/src/entity-extraction/entity-extraction-service.ts`

**Estimated scope:** M (1 file, ~80 lines changed)

---

#### Task P: Update entity-dedup.ts (table mappings + dedup target)

**Description:** Two changes:
1. Update `tableNameFor()` — add mappings for the new domain-prefixed type names pointing to their DB tables, and ensure `'Person'` maps to `'person'` (core table).
2. Update `batchResolve()` and `resolve()` — `_normalized_name` queries for Person-type dedup must target the core `person` table, not the extension table.

**New tableNameFor() entries:**
```typescript
case 'Person':          return 'person';           // core
case 'IntelSubject':    return 'intel_subject';     // osint extension
case 'Organization':    return 'organization';      // core
case 'IntelOrganization': return 'intel_organization';
case 'Location':        return 'location';          // core
case 'IntelLocation':   return 'intel_location';
case 'Equipment':       return 'equipment';         // core
case 'IntelEquipment':  return 'intel_equipment';
case 'IntelEvent':      return 'intel_event';
```

**Acceptance criteria:**
- [ ] `tableNameFor()` updated with all new type mappings
- [ ] `batchResolve()` queries `person._normalized_name` for Person-type entities
- [ ] `resolve()` queries `person._normalized_name` for Person-type entities
- [ ] Remove unused `fieldNameFor()` method (all queries use `_normalized_name` now)

**Verification:**
- [ ] `pnpm --filter @openfoundry/sync test` — all entity-dedup tests pass

**Dependencies:** Tasks A, F (core tables and extension tables must exist in schema)

**Files likely touched:**
- `packages/sync/src/entity-extraction/entity-dedup.ts`

**Estimated scope:** S (1 file, ~30 lines changed)

---

#### Task Q: Update backfill-normalized-names.ts

**Description:** Update the backfill script to include the core Person table and remove old type references.

**Acceptance criteria:**
- [ ] `TABLES` array includes `{ table: 'person', nameField: 'full_name', type: 'Person' }` (core table)
- [ ] Old `{ table: 'organization', nameField: 'name', type: 'Organization' }` → `organization` (core)
- [ ] Backfill script compiles and runs without errors

**Verification:**
- [ ] `npx tsc --noEmit tools/backfill-normalized-names.ts` — compiles
- [ ] Manual script execution against clean DB succeeds

**Dependencies:** Tasks A, O

**Files likely touched:**
- `tools/backfill-normalized-names.ts`

**Estimated scope:** XS (1 file)

---

#### Task R: Update tests + OpenFGA model

**Description:** Update all test files to reflect new type names and dual-create patterns. Regenerate OpenFGA model. Update `domain-packs/osint/pack.yaml` to declare dependency on `core`.

**Test files to update:**
- `entity-extraction-service.test.ts` — mock objectManager to expect dual creates
- `entity-dedup.test.ts` — use new type strings
- `entity-validation.test.ts` — use new type strings
- `osint-pack.test.ts` — update field assertions for new type structure

**Acceptance criteria:**
- [ ] All test files updated with new type names
- [ ] Tests assert dual creates (mock expects 2 `.create()` calls per entity)
- [ ] `pnpm --filter @openfoundry/sync test` — 302+ tests pass
- [ ] `deploy/openfga-model.json` regenerated from updated ODL
- [ ] `domain-packs/osint/pack.yaml` declares dependency on `core`

**Verification:**
- [ ] `pnpm --filter @openfoundry/sync test` — all tests pass
- [ ] OpenFGA model contains `type person`, `type intel_subject` etc.

**Dependencies:** O, P

**Files likely touched:**
- 4 test files
- `deploy/openfga-model.json`
- `domain-packs/osint/pack.yaml`

**Estimated scope:** M (6 files)

---

### Checkpoint: Phase 3
- [ ] All code changes applied
- [ ] All tests updated
- [ ] `pnpm --filter @openfoundry/sync test` — 302+ pass

---

### Phase 4: Verification

---

#### Task S: Docker compose clean start

**Description:** Due to schema checksum changes, volumes must be wiped. Run `docker compose down -v && docker compose up -d`. Verify all services start healthy.

**Acceptance criteria:**
- [ ] `docker compose down -v` succeeds
- [ ] `docker compose up -d` starts all 13 services
- [ ] PostgreSQL, OpenFGA, Redpanda, Keycloak, API gateway health checks pass
- [ ] NER pipeline initializes successfully
- [ ] No schema migration errors in logs

**Verification:**
- [ ] `docker compose ps` — all services healthy
- [ ] `curl localhost:4000/health` — returns 200

**Dependencies:** R

**Files likely touched:**
- None (operations only)

**Estimated scope:** S (operations)

---

#### Task T: Full build + test verification

**Description:** Run the complete test suite and build for all packages. Confirm no regressions.

**Acceptance criteria:**
- [ ] `pnpm run build` — all packages compile
- [ ] `pnpm --filter @openfoundry/sync test` — 302+ tests pass
- [ ] `pnpm --filter @openfoundry/odl test` — ODL tests pass
- [ ] `pnpm --filter @openfoundry/api build` — typecheck passes
- [ ] Pack loader discovers all types from new directory structure

**Verification:**
- [ ] All test suites green
- [ ] Zero TypeScript errors

**Dependencies:** S

**Files likely touched:**
- None (verification only)

**Estimated scope:** S (verification)

---

### Checkpoint: Final
- [ ] All 23 tasks complete
- [ ] All tests pass
- [ ] Build succeeds
- [ ] Docker stack starts clean
- [ ] Dual creates work for both OSINT (NER extraction) and NHS (register patient)
- [ ] Cross-domain queries possible (Person links to both IntelSubject and Patient)

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Schema checksum mismatches after ODL renames | High — startup fails | `docker compose down -v` before starting. Document in migration notes. |
| ODL type references in link types break | High — 30+ link types need updates | Use find-replace for mechanical renames. Verify with ODL compilation after each batch. |
| NHS Patient tests break on field removal | Medium — test assertions reference `name` field | Update test assertions in Task S. Tests are mechanical string replacements. |
| Pack loader fails to find types in new subdirectories | Medium — discovery issue | Verify pack loader uses recursive `.odl` discovery (likely). If hardcoded to `schema/`, need code change. |
| `batchResolve()` SQL references wrong table | High — dedup silently fails | Use `person._normalized_name` as canonical dedup target. Verify with unit tests. |
| Existing data in DB has old column names | Low — dev stack | Volume wipe avoids migration. Backfill script for future production use. |
| Dual creates in a single action exceed transaction scope | Low | Both creates run in the same ActionExecutor transaction (Step 5 in execute()). |

---

## Files Summary

| File | Tasks | Change Type |
|------|-------|-------------|
| `core/objects/person.odl` | A | NEW |
| `core/objects/organization.odl` | A | NEW |
| `core/objects/location.odl` | A | NEW |
| `core/objects/equipment.odl` | A | NEW |
| `core/links.odl` | B, G | NEW + MODIFY |
| `core/pack.yaml` | B | MODIFY |
| `nhs-acute/objects/patient.odl` | C | MOVE + MODIFY |
| `nhs-acute/objects/consultant.odl` | D | MOVE + MODIFY |
| `nhs-acute/actions/register-patient.yaml` | E | MODIFY |
| `osint/objects/intel-subject.odl` | F | NEW |
| `osint/objects/intel-organization.odl` | G | NEW |
| `osint/objects/intel-location.odl` | G | NEW |
| `osint/objects/intel-equipment.odl` | G | NEW |
| `osint/objects/intel-event.odl` | H | NEW |
| `osint/observations/intel-report.odl` | I | MOVE + MODIFY |
| `osint/observations/source-profile.odl` | I | MOVE + MODIFY |
| `osint/workflows/assessment.odl` | J | MOVE + MODIFY |
| `osint/workflows/indicator.odl` | J | MOVE + MODIFY |
| `osint/workflows/narrative.odl` | J | MOVE + MODIFY |
| `osint/links.odl` | K | MODIFY (~30 replacements) |
| `entity-extraction-service.ts` | O | MODIFY (dual creates) |
| `entity-dedup.ts` | P | MODIFY (table mappings) |
| `backfill-normalized-names.ts` | Q | MODIFY |
| `osint-pack.test.ts` | R | MODIFY |
| `entity-extraction-service.test.ts` | R | MODIFY |
| `entity-dedup.test.ts` | R | MODIFY |
| `entity-validation.test.ts` | R | MODIFY |
| `deploy/openfga-model.json` | R | MODIFY |
| `osint/pack.yaml` | R | MODIFY |

**Files created:** 12
**Files modified:** 18
**Files deleted:** 12 (`osint/schema/person.odl`, `osint/schema/organization.odl`, `osint/schema/location.odl`, `osint/schema/equipment.odl`, `osint/schema/event.odl`, `osint/schema/intel-report.odl`, `osint/schema/source-profile.odl`, `osint/schema/assessment.odl`, `osint/schema/indicator.odl`, `osint/schema/narrative.odl`, `nhs-acute/schema/patient.odl`, `nhs-acute/schema/consultant.odl`)
**Files moved:** 15 (all `schema/` → layered subdirectories across packs)
**Total touched:** ~42 files
