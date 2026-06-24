---
title: ODL Link Fix & Dedup Cleanup — Specification
created: 2026-06-20
last_updated: 2026-06-20
type: spec
status: accepted
related_components:
  - sync-engine
  - ner-extraction
  - odl
related_features:
  - osint-domain-pack
  - ner-link-consistency-fix-spec
  - odl-link-and-dedup-cleanup-plan
related_decisions:
  - adr-013-palantir-domain-pack-refactor
  - adr-012-ner-python-sidecar
---

# Spec: ODL Link Fix & Dedup Cleanup

## 1. Objective

Fix three interrelated issues discovered in the NER entity pipeline:

1. **ODL link type naming conflict** — `ProfileForPerson` is defined in both the core pack (IntelSubject → Person) and the OSINT pack (SourceProfile → IntelSubject), causing the core definition to be silently overwritten.

2. **Missing data-model links** — `createEntity` creates domain entities and Intel extensions but never creates the ODL-declared links between them (ProfileForPerson, OrgProfileForOrganization, etc.). This means IntelSubject._id cannot be traversed to Person._id to get core fields.

3. **Dedup workaround cleanup** — `_normalizedName` was added to Intel extension ODL types and `tableNameFor` was changed to query Intel tables as a workaround for #2. These should be reverted once data-model links exist.

**Success looks like:**
- `ProfileForPerson` resolves to `IntelSubject → Person` (from core pack) with no ambiguity
- SourceProfile → IntelSubject uses its own link type name (renamed from ProfileForPerson)
- `createEntity` creates all 4 data-model links (ProfileForPerson, OrgProfileForOrganization, LocationProfileForLocation, EquipmentProfileForEquipment)
- `_normalizedName` removed from IntelSubject, IntelOrganization, IntelLocation, IntelEquipment ODL
- `tableNameFor` queries domain tables (person, organization, location, equipment) again
- All 316 TS tests pass, all 66 Python tests pass
- Zero OBJECT_NOT_FOUND errors after Docker rebuild + deploy

## 2. Current State

### 2.1 ODL Conflict

**Core pack** (`domain-packs/core/links.odl:10`):
```
type ProfileForPerson @linkType(from: "IntelSubject", to: "Person")
```
Intended as the IntelSubject → Person data-model link. Used by all domain packs' extension types to link back to core entities.

**OSINT pack** (`domain-packs/osint/schema/links.odl:91`):
```
type ProfileForPerson @linkType(from: "SourceProfile", to: "IntelSubject", cardinality: MANY_TO_ONE)
```
Reuses the same name for SourceProfile → IntelSubject (a source tracking relationship). Since the ODL compiler loads packs sequentially, the OSINT definition overwrites the core definition at runtime. `ProfileForPerson` means SourceProfile → IntelSubject, not IntelSubject → Person.

### 2.2 Missing data-model links

`createEntity()` in `entity-extraction-service.ts` creates domain entities and Intel extensions independently:
```typescript
case 'Person': {
  await this.objectManager.create('Person', {...}, ctx);
  await this.objectManager.create('IntelSubject', {...}, ctx);
  return subject._id;
}
```
No `linkManager.createLink()` call between them. The ODL-declared `person: Person! @link(type: "ProfileForPerson")` was never materialized at the DB level.

### 2.3 Dedup workaround

Because Person._id ≠ IntelSubject._id and no link exists between them, `batchResolve` couldn't return Intel extension IDs (needed for Mentions* links). The workaround added:

1. `_normalizedName: String @indexed` to IntelSubject, IntelOrganization, IntelLocation, IntelEquipment ODL (4 files)
2. `_normalizedName` passed to Intel extension `create()` calls (11 lines in `createEntity`)
3. `tableNameFor()` changed to query Intel tables instead of domain tables (4 rows)

### 2.4 What stays unchanged

- IntelEvent already had `_normalizedName: String! @indexed` in the original ODL — NOT a workaround, it stays
- The two-phase `processReport` (Phase 1 creates, Phase 2 links) — stays
- `EntityDedupCache.remove()` and `verifyId()` — utility methods, stay
- `ALTER TABLE ADD COLUMN IF NOT EXISTS` in `ddl-objects.ts` — general improvement, stays
- Ner-service restructure (uv migration, src-layout) — stays

## 3. Solution

### 3.1 Phase 1a — ODL link rename

| File | Change | Lines |
|------|--------|-------|
| `domain-packs/osint/schema/links.odl` | Rename `ProfileForPerson` → `SourceProfileForPerson` (line 91) | 1 |
| `domain-packs/osint/schema/links.odl` | Rename `ProfileForOrganization` → `SourceProfileForOrganization` (line 95) | 1 |
| `domain-packs/osint/objects/intel-subject.odl` | Update `sourceProfiles` link type name (line 31) | 1 |
| `domain-packs/osint/objects/intel-organization.odl` | Update `sourceProfiles` link type name (line 39) | 1 |
| `domain-packs/osint/observations/source-profile.odl` | Update both `@link` references (lines 43-44) | 2 |

After this, `ProfileForPerson` resolves to its sole definition: **IntelSubject → Person** (core pack).

### 3.2 Phase 1b — ODL _normalizedName revert

| File | Change | Lines |
|------|--------|-------|
| `domain-packs/osint/objects/intel-subject.odl` | Remove `_normalizedName: String @indexed` (line 18) | 1 |
| `domain-packs/osint/objects/intel-organization.odl` | Remove `_normalizedName: String @indexed` (line 18) | 1 |
| `domain-packs/osint/objects/intel-location.odl` | Remove `_normalizedName: String @indexed` (line 18) | 1 |
| `domain-packs/osint/objects/intel-equipment.odl` | Remove `_normalizedName: String @indexed` (line 18) | 1 |

### 3.3 Phase 2 — Add data-model links to createEntity

After creating both domain and Intel entities, create the ODL-declared link:

```typescript
case 'Person': {
  const person = await this.objectManager.create('Person', {
    ...base, fullName: entity.name, _normalizedName: normalizedName,
  }, ctx);
  const subject = await this.objectManager.create('IntelSubject', {
    ...base, watchlistStatus: 'NONE', isPersonOfInterest: false,
  }, ctx);
  await this.linkManager.createLink(
    'ProfileForPerson', subject._id, person._id, {}, ctx,
  );
  return subject._id;
}
```

Apply the same pattern to all entity types:

| Entity type | Link type | From | To |
|-------------|-----------|------|-----|
| Person | ProfileForPerson | IntelSubject | Person |
| Organization, MilitaryUnit, ArmedGroup | OrgProfileForOrganization | IntelOrganization | Organization |
| Location, ConflictZone | LocationProfileForLocation | IntelLocation | Location |
| Equipment, WeaponSystem | EquipmentProfileForEquipment | IntelEquipment | Equipment |
| Event | _no domain link needed_ | — | — |

### 3.4 Phase 3 — Revert dedup workaround with JOIN translation

After data-model links exist, `batchResolve` can query domain tables and JOIN the link table to translate Person._id → IntelSubject._id in a single query.

**`batchResolve` SQL — before (workaround):**
```sql
SELECT "_id", "normalized_name" FROM public.intel_subject
WHERE "_tenant_id" = $1 AND "normalized_name" = ANY($2)
  AND "_deleted_at" IS NULL
```
Queries Intel table directly. Returns IntelSubject._id but requires `_normalizedName` on Intel tables.

**`batchResolve` SQL — after (with JOIN):**
```sql
SELECT pf."_from_id" AS "_id", p."normalized_name"
FROM public.person p
JOIN public.profile_for_person pf
  ON pf."_to_id" = p."_id"
  AND pf."_tenant_id" = p."_tenant_id"
  AND pf."_deleted_at" IS NULL
WHERE p."_tenant_id" = $1 AND p."normalized_name" = ANY($2)
  AND p."_deleted_at" IS NULL
```
Queries domain table, JOINs link table. Returns IntelSubject._id via `pf._from_id`. Same result, no duplicated columns.

Link table JOIN mapping per entity type:

| Entity type | Domain table | Link table joined | Returns |
|-------------|-------------|-------------------|---------|
| Person | person | profile_for_person | IntelSubject._id |
| Organization, MilitaryUnit, ArmedGroup | organization | org_profile_for_organization | IntelOrganization._id |
| Location, ConflictZone | location | location_profile_for_location | IntelLocation._id |
| Equipment, WeaponSystem | equipment | equipment_profile_for_equipment | IntelEquipment._id |
| Event | intel_event | _no JOIN_ | IntelEvent._id |

**Fallback for legacy data:** If a Person row exists but has no ProfileForPerson link, the JOIN returns no rows → batchResolve treats as cache miss → `createEntity` runs → creates fresh IntelSubject + link. Old orphan entities without links remain in the DB but don't cause errors — they're never referenced by the dedup query.

**`tableNameFor`** — revert to domain tables after the JOIN handles translation:
```
Person → person (was intel_subject)
Organization → organization (was intel_organization)
Location → location (was intel_location)
Equipment → equipment (was intel_equipment)
```

**`createEntity`** — remove 11 `_normalizedName` lines from Intel extension `create()` calls (keep on domain entity creates and IntelEvent).

### 3.5 Phase 4 — DB migration

Drop columns added by the workaround:
```sql
ALTER TABLE intel_subject DROP COLUMN IF EXISTS normalized_name;
ALTER TABLE intel_organization DROP COLUMN IF EXISTS normalized_name;
ALTER TABLE intel_location DROP COLUMN IF EXISTS normalized_name;
ALTER TABLE intel_equipment DROP COLUMN IF EXISTS normalized_name;
```

IntelEvent keeps `normalized_name` (pre-existing schema).

Update `_schema_migrations` checksum or reset to allow fresh ODL migration (dropping columns changes the DDL checksum).

## 4. Commands

```bash
# Tests
cd packages/sync && pnpm run test          # 316 TS tests
cd packages/sync && pnpm run typecheck     # TS typecheck
cd packages/ner-service && uv run pytest   # 66 Python tests

# Build + Deploy
cd deploy && docker compose build --no-cache api-gateway
cd deploy && docker compose up -d api-gateway

# Verify
docker logs deploy-api-gateway-1 2>&1 | grep "OBJECT_NOT_FOUND" | wc -l  → 0
docker logs deploy-api-gateway-1 2>&1 | grep "NER: extracted" | tail -5   → entitiesCreated>0, errors:0
```

## 5. Code Style

### 5.1 createEntity with data-model links

```typescript
case 'Person': {
  const person = await this.objectManager.create('Person', {
    ...base, fullName: entity.name, _normalizedName: normalizedName,
  }, ctx);
  const subject = await this.objectManager.create('IntelSubject', {
    ...base, watchlistStatus: 'NONE', isPersonOfInterest: false,
  }, ctx);
  await this.linkManager.createLink('ProfileForPerson', subject._id, person._id, {}, ctx);
  return subject._id;
}
case 'Organization':
case 'MilitaryUnit': {
  const org = await this.objectManager.create('Organization', {
    ...base, name: entity.name, _normalizedName: normalizedName,
  }, ctx);
  const intelOrg = await this.objectManager.create('IntelOrganization', {
    ...base, type: entity.type === 'MilitaryUnit' ? 'MILITARY_UNIT' : 'OTHER', isDesignated: false,
  }, ctx);
  await this.linkManager.createLink('OrgProfileForOrganization', intelOrg._id, org._id, {}, ctx);
  return intelOrg._id;
}
```

## 6. Testing Strategy

- **TS tests:** Existing 316 tests must pass without modification. The `createEntity` change adds link creation — existing mock `linkManager.createLink` already works (vi.fn mock).
- **Mock verification:** The existing test mock for `linkManager.createLink` captures calls. After adding 4 ProfileFor* links, the mock call count per entity will increase — verify expected count.
- **Docker smoke:** Deploy, wait for ingestion, verify zero OBJECT_NOT_FOUND, check `profile_for_person` table has rows.

## 7. Files Touched

| File | Action | Lines |
|------|--------|-------|
| `domain-packs/osint/schema/links.odl` | MODIFY | 2 renames |
| `domain-packs/osint/objects/intel-subject.odl` | MODIFY | 2 (rename link + remove _normalizedName) |
| `domain-packs/osint/objects/intel-organization.odl` | MODIFY | 2 |
| `domain-packs/osint/objects/intel-location.odl` | MODIFY | 1 (remove _normalizedName) |
| `domain-packs/osint/objects/intel-equipment.odl` | MODIFY | 1 |
| `domain-packs/osint/observations/source-profile.odl` | MODIFY | 2 |
| `packages/sync/src/entity-extraction/entity-extraction-service.ts` | MODIFY | ~25 lines (add 4 links + remove 11 _normalizedName) |
| `packages/sync/src/entity-extraction/entity-dedup.ts` | MODIFY | ~40 lines (JOIN SQL + revert tableNameFor + link table mapping) |

Total: ~8 files, ~50 lines changed, ~15 lines removed. See [[odl-link-and-dedup-cleanup-plan]] for detailed task breakdown.

## 8. Dependencies

```
Phase 1a (ODL rename) ──┐
                          ├── Phase 2 (createEntity links) ──┬── Phase 3a (JOIN in batchResolve)
Phase 1b (ODL revert)  ──┘                                  ├── Phase 3b (revert tableNameFor)
                                                             └── Phase 3c (revert createEntity)
                                                                       │
                                                             Phase 4 (DB migration)
                                                                       │
                                                             Phase 5 (Deploy + Verify)
```

Phase 1a and 1b are independent. Phase 2 needs Phase 1a. Phase 3a/b/c need Phase 2 (links must exist first). Phase 4 can run after Phase 3.

## 9. Success Criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| 1 | ODL: ProfileForPerson only defined in core pack | `grep -rn "ProfileForPerson @linkType" domain-packs/` → 1 result in core/ |

| 2 | ODL: IntelSubject, IntelOrganization, IntelLocation, IntelEquipment have no `_normalizedName` | `grep _normalizedName domain-packs/osint/objects/intel-{subject,organization,location,equipment}.odl` → empty |

| 3 | `createEntity` creates ProfileForPerson link for new entities | Test: mock linkManager.calls include `['ProfileForPerson', ...]` |

| 4 | `tableNameFor` returns domain table names | Test: `dedup.tableNameFor('Person')` → `'person'` |

| 5 | All 316 TS tests pass | `cd packages/sync && pnpm run test` |

| 6 | All 66 Python tests pass | `cd packages/ner-service && uv run pytest` |

| 7 | Docker rebuild + deploy succeeds | `docker compose build --no-cache api-gateway && docker compose up -d api-gateway` |
| 8 | Zero OBJECT_NOT_FOUND after 5+ min ingestion | `docker logs deploy-api-gateway-1 2>&1 \| grep -c "OBJECT_NOT_FOUND"` → 0 |
| 9 | `profile_for_person` table has rows | `SELECT COUNT(*) FROM profile_for_person` → > 0 |
| 10 | `mentions_person` has zero orphans | PSQL: `NOT EXISTS` check against intel_subject |

## 10. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `linkManager.createLink()` in `createEntity` fails | Medium | Medium | Phase 1 try/catch already handles entity creation failures. Link failure → entity still created, link missing. Same pattern as existing link failures. |
| ODL rename breaks graph queries | Low | Medium | `sourceProfiles` field on IntelSubject uses the renamed link type. Existing graph traversal via `@link` field resolves correctly after rename. |
| JOIN in batchResolve adds latency | Low | Low | B-tree indexed join on primary keys. < 1ms per batch query. Four queries total, same as current. |
| Legacy entities without ProfileForPerson links | Medium | Medium | Without link, JOIN returns no rows → batchResolve treats as cache miss → `createEntity` runs → creates fresh IntelSubject + link. Old orphan IntelSubjects remain but never cause errors. |

## 11. Boundaries

- **Always:** Run full TS test suite before deploy. Verify zero OBJECT_NOT_FOUND after 5+ minutes of ingestion.
- **Ask first:** Changes to `linkManager.createLink()` API. Adding new link types to core pack.
- **Never:** Delete `ProfileForPerson` from core pack. Skip creating data-model links in `createEntity`. Change IntelEvent's existing `_normalizedName`.

## 12. Open Questions

> Resolved during planning. See [[odl-link-and-dedup-cleanup-plan]] for implementation details.

1. ~~Cold-start dedup after revert~~ — **Resolved:** `batchResolve` JOINs `profile_for_person` to translate Person._id → IntelSubject._id in a single SQL query. Legacy entities without links fall through to `createEntity`.

2. ~~Should batchResolve include the JOIN~~ — **Resolved: Yes.** One JOIN per table (4 total). Same number of queries as current, same performance characteristics.

3. ~~Backfill existing entities~~ — **Resolved:** No backfill needed. The JOIN handles it — missing links → cache miss → createEntity creates fresh. Old orphans remain inert.
