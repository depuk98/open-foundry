---
title: ODL Link Fix & Dedup Cleanup — Implementation Plan
created: 2026-06-20
type: feature
status: planned
related_components:
  - sync-engine
  - ner-extraction
  - odl
related_features:
  - osint-domain-pack
  - odl-link-and-dedup-cleanup-spec
related_decisions:
  - adr-013-palantir-domain-pack-refactor
---

# Implementation Plan: ODL Link Fix & Dedup Cleanup

## Overview

Fix the ODL link type naming conflict, add missing data-model links in `createEntity`, and revert the `_normalizedName` workaround. Zero behavioral changes to the NER extraction pipeline — same entities, same links, same dedup behavior — just through the correct architectural path.

Reference spec: [[odl-link-and-dedup-cleanup-spec]]

## Architecture Decision

**ProfileForPerson JOIN in batchResolve:** After `createEntity` creates ProfileForPerson links for new entities, `batchResolve`'s DB query JOINs the link table to translate Person._id → IntelSubject._id. This means:
- Domain tables (person, organization, etc.) remain the dedup source of truth via `normalized_name`
- The JOIN automatically resolves the Intel extension ID for linking
- Cold start works: if Person row exists with ProfileForPerson link → returns Intel ID. If link missing (legacy data) → returns null → createEntity runs → creates new IntelSubject + link
- No extra application-level lookup — the SQL handles everything

## Task List

### Phase 1: ODL Cleanup

#### Task 1: Rename conflicting OSINT link types

**Description:** Rename `ProfileForPerson` → `SourceProfileForPerson` and `ProfileForOrganization` → `SourceProfileForOrganization` in the OSINT pack's `schema/links.odl`. Update all `@link(type: ...)` references in Intel extension and SourceProfile ODL files.

After this, `ProfileForPerson` resolves to its sole core pack definition: **IntelSubject → Person**.

**Acceptance criteria:**
- [ ] `grep -rn "ProfileForPerson @linkType" domain-packs/` → only `core/links.odl:10`
- [ ] `osint/schema/links.odl` has `SourceProfileForPerson` and `SourceProfileForOrganization`
- [ ] `intel-subject.odl:31` refs `SourceProfileForPerson`
- [ ] `intel-organization.odl:39` refs `SourceProfileForOrganization`
- [ ] `source-profile.odl:43-44` refs new names

**Verification:**
- [ ] `grep -rn "ProfileForPerson @linkType" domain-packs/core/` → 1 match
- [ ] `grep -rn "SourceProfileForPerson" domain-packs/osint/` → 3 matches (link def + 2 usages)

**Dependencies:** None

**Files:**
- `domain-packs/osint/schema/links.odl` — MODIFY (2 lines)
- `domain-packs/osint/objects/intel-subject.odl` — MODIFY (1 line)
- `domain-packs/osint/objects/intel-organization.odl` — MODIFY (1 line)
- `domain-packs/osint/observations/source-profile.odl` — MODIFY (2 lines)

**Estimated scope:** XS (4 files, 6 name changes)

---

#### Task 2: Remove _normalizedName from Intel extension ODL types

**Description:** Revert the `_normalizedName: String @indexed` additions from IntelSubject, IntelOrganization, IntelLocation, IntelEquipment. IntelEvent's `_normalizedName: String! @indexed` stays (pre-existing in original ODL).

**Acceptance criteria:**
- [ ] IntelSubject, IntelOrganization, IntelLocation, IntelEquipment ODL have no `_normalizedName` line
- [ ] IntelEvent ODL still has `_normalizedName: String! @indexed`

**Verification:**
- [ ] `grep _normalizedName domain-packs/osint/objects/intel-subject.odl` → empty
- [ ] `grep _normalizedName domain-packs/osint/objects/intel-event.odl` → 1 match

**Dependencies:** None

**Files:**
- `domain-packs/osint/objects/intel-subject.odl` — MODIFY (remove 1 line)
- `domain-packs/osint/objects/intel-organization.odl` — MODIFY (remove 1 line)
- `domain-packs/osint/objects/intel-location.odl` — MODIFY (remove 1 line)
- `domain-packs/osint/objects/intel-equipment.odl` — MODIFY (remove 1 line)

**Estimated scope:** XS (4 files, 4 deletions)

---

### Checkpoint: ODL Clean
- [ ] ProfileForPerson means IntelSubject → Person (only in core)
- [ ] No _normalizedName on Intel extension types (except IntelEvent)

---

### Phase 2: Data-Model Links

#### Task 3: Add ProfileForPerson link creation to createEntity

**Description:** After creating Person + IntelSubject in `createEntity`, create the ProfileForPerson link. Same pattern for Organization, Location, Equipment.

The link goes from **Intel extension → domain entity** (matching the ODL direction):

| Entity type | Link type | From | To |
|-------------|-----------|------|-----|
| Person | ProfileForPerson | IntelSubject._id | Person._id |
| Organization, MilitaryUnit, ArmedGroup | OrgProfileForOrganization | IntelOrganization._id | Organization._id |
| Location, ConflictZone | LocationProfileForLocation | IntelLocation._id | Location._id |
| Equipment, WeaponSystem | EquipmentProfileForEquipment | IntelEquipment._id | Equipment._id |
| Event | _none_ | — | — |

**Acceptance criteria:**
- [ ] `createEntity` creates link right after both objects are created
- [ ] Link creation failure is caught by existing try/catch (counts as error, doesn't crash)
- [ ] Event type unchanged (no domain counterpart)

**Verification:**
- [ ] `cd packages/sync && pnpm run test` — all 316 tests pass
- [ ] Test: new ProfileForPerson link call captured by mock linkManager

**Dependencies:** Task 1 (needs correct ProfileForPerson definition)

**Files:**
- `packages/sync/src/entity-extraction/entity-extraction-service.ts` — MODIFY (~8 lines added)

**Estimated scope:** S (1 file, 4 link creations)

---

### Checkpoint: Links Created
- [ ] createEntity now creates ProfileForPerson links
- [ ] All 316 tests pass

---

### Phase 3: Revert Workaround + JOIN

#### Task 4: Add ProfileForPerson JOIN to batchResolve DB queries

**Description:** Modify the SQL query in `batchResolve` to JOIN the ProfileForPerson link table, translating domain entity IDs to Intel extension IDs.

Current query for Person type (from `person` table):
```sql
SELECT "_id", "normalized_name" FROM public.person
WHERE "_tenant_id" = $1 AND "normalized_name" = ANY($2) AND "_deleted_at" IS NULL
```

New query (JOINs `profile_for_person`):
```sql
SELECT pf."_from_id" AS "_id", p."normalized_name"
FROM public.person p
JOIN public.profile_for_person pf
  ON pf."_to_id" = p."_id" AND pf."_tenant_id" = p."_tenant_id" AND pf."_deleted_at" IS NULL
WHERE p."_tenant_id" = $1 AND p."normalized_name" = ANY($2) AND p."_deleted_at" IS NULL
```

Mapping of entity type → link table for JOIN:
- Person → `profile_for_person` (results in IntelSubject._id)
- Organization/MilitaryUnit/ArmedGroup → `org_profile_for_organization` (results in IntelOrganization._id)
- Location/ConflictZone → `location_profile_for_location` (results in IntelLocation._id)
- Equipment/WeaponSystem → `equipment_profile_for_equipment` (results in IntelEquipment._id)
- Event → _no JOIN needed_ (Event IS IntelEvent)

**Acceptance criteria:**
- [ ] batchResolve returns Intel extension IDs (not domain IDs) for DB hits
- [ ] Cache entries store Intel extension IDs (same as createEntity sets)
- [ ] Cold start: existing Person row WITH ProfileForPerson link → returns IntelSubject._id
- [ ] Cold start: existing Person row WITHOUT ProfileForPerson link → returns null (falls through to createEntity)
- [ ] Warm cache: same behavior as before (cached Intel IDs returned directly)

**Verification:**
- [ ] `cd packages/sync && pnpm run test` — all 316 tests pass
- [ ] Test: mock pool returns domain rows + link rows → batchResolve returns Intel ID

**Dependencies:** Task 3 (links must be created first)

**Files:**
- `packages/sync/src/entity-extraction/entity-dedup.ts` — MODIFY (~30 lines, SQL + link table mapping)

**Estimated scope:** M (1 file, ~30 lines of SQL logic)

---

#### Task 5: Revert tableNameFor to domain tables

**Description:** Change `tableNameFor` back from Intel extension tables to domain tables. The JOIN in Task 4 handles the ID translation, so the base table queried for `normalized_name` should be the domain table (where the column lives).

Current (workaround):
```
Person → intel_subject
Organization → intel_organization
Location → intel_location
Equipment → intel_equipment
```

Reverted (original):
```
Person → person
Organization → organization
Location → location
Equipment → equipment
Event → intel_event  (unchanged)
```

**Acceptance criteria:**
- [ ] `tableNameFor('Person')` → `'person'`
- [ ] `tableNameFor('Organization')` → `'organization'`
- [ ] `tableNameFor('Location')` → `'location'`
- [ ] `tableNameFor('Equipment')` → `'equipment'`

**Verification:**
- [ ] `cd packages/sync && pnpm run test` — all tests pass
- [ ] Existing dedup tests still work (mock pool ignores table name)

**Dependencies:** Task 4 (JOIN handles the translation)

**Files:**
- `packages/sync/src/entity-extraction/entity-dedup.ts` — MODIFY (4 lines)

**Estimated scope:** XS (1 file, 4 lines)

---

#### Task 6: Remove _normalizedName from createEntity Intel calls

**Description:** Remove `_normalizedName: normalizedName` from Intel extension `create()` calls in `createEntity`. Keep `_normalizedName` on domain entity creates (person, organization, location, equipment) and on IntelEvent.

Lines to remove (11 total):
- IntelSubject create: 1 line
- IntelOrganization create (Org + MilitaryUnit + ArmedGroup): 3 lines
- IntelLocation create (Location + ConflictZone): 2 lines
- IntelEquipment create (Equipment + WeaponSystem): 2 lines
- IntelEvent: KEEP (pre-existing, 1 line, unchanged)
- Domain creates: KEEP (person, organization, location, equipment: 4 lines, unchanged)

**Acceptance criteria:**
- [ ] No `_normalizedName` on IntelSubject, IntelOrganization, IntelLocation, IntelEquipment creates
- [ ] Domain creates still pass `_normalizedName`
- [ ] IntelEvent create still passes `_normalizedName`

**Verification:**
- [ ] `grep "_normalizedName" entity-extraction-service.ts` → 5 matches (4 domain + 1 IntelEvent), no other Intel types
- [ ] `cd packages/sync && pnpm run test` — all tests pass

**Dependencies:** Task 4 (Intel tables no longer need _normalizedName for dedup)

**Files:**
- `packages/sync/src/entity-extraction/entity-extraction-service.ts` — MODIFY (remove 11 lines)

**Estimated scope:** XS (1 file, 11 deletions)

---

### Checkpoint: Workaround Reverted
- [ ] tableNameFor uses domain tables
- [ ] batchResolve JOINs link tables to get Intel IDs
- [ ] createEntity no longer passes _normalizedName to Intel creates
- [ ] All 316 tests pass

---

### Phase 4: DB Migration

#### Task 7: DB column cleanup and schema migration

**Description:** The ODL changes (removing `_normalizedName` from 4 Intel types) will change the DDL checksum. Before redeploying:

1. Drop the `normalized_name` columns from Intel tables (they were manually added, will be removed by new migration)
2. Reset the `_schema_migrations` table so the migration re-applies fresh
3. After redeploy, verify the link table has rows

No backfill needed — legacy entities without ProfileForPerson links are handled naturally: the JOIN returns null → treated as cache miss → `createEntity` creates fresh IntelSubject + link.

**Acceptance criteria:**
- [ ] `intel_subject`, `intel_organization`, `intel_location`, `intel_equipment` have no `normalized_name` column
- [ ] `_schema_migrations` has updated checksum or version 1 row deleted
- [ ] `profile_for_person` has rows after ingestion (links created by createEntity)

**Verification:**
- [ ] PSQL: `SELECT column_name FROM information_schema.columns WHERE table_name = 'intel_subject' AND column_name = 'normalized_name'` → empty
- [ ] `docker logs deploy-api-gateway-1 | grep "Failed to start"` → empty

**Dependencies:** Tasks 1-6 complete

**Files:** None (SQL commands, executed manually or via init)

**Estimated scope:** S (SQL commands, manual)

---

### Phase 5: Integration

#### Task 8: Docker rebuild + deploy

**Description:** Rebuild the API gateway with all changes, deploy, and verify the pipeline works end-to-end with the new link-based dedup.

**Acceptance criteria:**
- [ ] `docker compose build --no-cache api-gateway` — success
- [ ] `docker compose up -d api-gateway` — healthy
- [ ] Schema migration applies without errors
- [ ] NER pipeline initializes

**Verification:**
- [ ] `docker logs deploy-api-gateway-1 | grep "listening"` — API gateway started
- [ ] `docker logs deploy-api-gateway-1 | grep "Schema:"` — loaded with new ODL

**Dependencies:** Task 7

**Files:** None (Docker config unchanged)

**Estimated scope:** S (build + deploy)

---

#### Task 9: End-to-end verification

**Description:** Wait for Twitter ingestion, then audit:
1. Zero OBJECT_NOT_FOUND errors
2. ProfileForPerson links created for new entities
3. MentionsPerson, MentionsOrganization, etc. links created without errors
4. No duplicate entities

**Acceptance criteria:**
- [ ] `docker logs deploy-api-gateway-1 2>&1 | grep -c "OBJECT_NOT_FOUND"` → 0
- [ ] `docker logs deploy-api-gateway-1 2>&1 | grep "NER: extracted" | tail -5` → all have errors: 0
- [ ] `SELECT COUNT(*) FROM profile_for_person` → > 0
- [ ] `SELECT COUNT(*) FROM mentions_person mp WHERE NOT EXISTS (SELECT 1 FROM intel_subject s WHERE s._id = mp._to_id)` → 0

**Verification:**
- [ ] Wait 5+ minutes for ingestion
- [ ] Run PSQL audit queries
- [ ] Run docker log audit

**Dependencies:** Task 8

**Files:** None

**Estimated scope:** S (monitoring + audit)

---

## Task Dependency Graph

```
Task 1 (ODL rename) ──┬── Task 3 (createEntity links) ──┬── Task 4 (JOIN) ──┬── Task 5 (revert tableNameFor)
Task 2 (ODL revert)  ──┘                                  │                  └── Task 6 (revert createEntity)
                                                          │
                                                          └── Task 7 (DB) → Task 8 (Docker) → Task 9 (Verify)
```

Tasks 1 and 2 are parallel.
Task 3 depends on Task 1.
Tasks 4, 5, 6 depend on Task 3.
Task 7 is the DB migration gate.
Tasks 8-9 are integration verification.

## Files Changed Summary

| Phase | Task | File | Action | Lines |
|-------|------|------|--------|-------|
| 1 | 1 | 4 ODL files | RENAME | ~6 |
| 1 | 2 | 4 ODL files | DELETE | ~4 |
| 2 | 3 | entity-extraction-service.ts | ADD | +8 |
| 3 | 4 | entity-dedup.ts | MODIFY SQL | ~30 |
| 3 | 5 | entity-dedup.ts | MODIFY | ~4 |
| 3 | 6 | entity-extraction-service.ts | DELETE | -11 |
| 4 | 7 | DB (manual) | SQL | ~10 |
| 5 | 8-9 | None | Verify | — |

Total: ~10 files, ~50 lines changed, ~15 lines removed.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| ProfileForPerson link creation fails in createEntity | Medium | Low | Phase 1 try/catch already handles entity processing failures. Link failure logs warning, counts error, other entities unaffected. |
| JOIN in batchResolve adds latency | Low | Low | B-tree indexed join on primary keys. < 1ms per batch query. |
| Legacy entities without ProfileForPerson links | Medium | Medium | Without link, JOIN returns no rows → treat as cache miss → createEntity runs → creates new IntelSubject + link. Old orphan IntelSubjects remain but don't cause errors. |
| Migration checksum mismatch on redeploy | Medium | High | Reset `_schema_migrations` before redeploy. Schema changes are small (4 column drops). |

## Verification Gates

- [ ] After Task 2: ODL is clean (no conflicts, no _normalizedName on Intel types except Event)
- [ ] After Task 3: createEntity creates ProfileForPerson links
- [ ] After Task 6: Workaround fully reverted, all tests pass
- [ ] After Task 9: Zero OBJECT_NOT_FOUND, profile_for_person has rows
