---
title: NER Pipeline — Link Consistency Fix (OBJECT_NOT_FOUND)
created: 2026-06-20
last_updated: 2026-06-20
type: spec
status: resolved — two-phase approach selected, implementation plan available
related_components:
  - ner-extraction
  - sync-engine
related_features:
  - osint-domain-pack
  - ner-code-review-findings-spec
  - ner-link-consistency-fix-plan
related_decisions:
  - adr-013-palantir-domain-pack-refactor
  - adr-012-ner-python-sidecar
---

# Spec: NER Pipeline — Link Consistency Fix

## 1. Objective

Fix intermittent `OBJECT_NOT_FOUND` errors when `linkManager.createLink()` validates a target entity that was just created via `objectManager.create()` in the same `createEntity()` call.

**Primary root cause (now fixed):** The `person: person._id` in `IntelSubject.create()` caused ODL validation failure, preventing Intel extension creation entirely. The code still attempted to link using the nonexistent ID. This was the 100% entity creation failure (`entitiesCreated: 0`) — **fixed in the prior session** by removing inline `@link` properties from all `createEntity` calls.

**Secondary defense-in-depth:** After the primary fix, two residual risks remain:
- **Stale dedup cache entries:** In-memory `EntityDedupCache` entries can survive DB-cleaning operations performed between container restarts (e.g., manual DELETE queries without redeploying). The cache returns a now-deleted entity ID → link validation fails.
- **Theoretical read-after-write gap:** With the current interleaved create-then-link loop, entity creation and link validation use separate pool connections. PostgreSQL READ COMMITTED guarantees visibility of committed writes across connections, so this is theoretical only — but a two-phase approach eliminates the gap entirely.

**Impact:** Prior to the primary fix, ~100% of reports had errors. After the primary fix, OBJECT_NOT_FOUND errors should drop to near zero. The two-phase refactor is defense-in-depth to eliminate the theoretical gap and handle the stale-cache edge case.

**Who this is for:** The NER pipeline and any downstream system that traverses `MentionsPerson`/`MentionsLocation`/`MentionsOrganization`/`MentionsEquipment`/`ReportedEvent` links.

**Success looks like:**
- 0 `OBJECT_NOT_FOUND` errors across 10+ minutes of continuous ingestion
- All 5 link tables have zero orphaned references (no `_to_id` pointing to a deleted target)
- `entitiesCreated` correctly tracks created entities
- No regression in dedup behavior (same entity name still resolves to single DB row)

## 2. Deep Diagnosis

### 2.1 Primary Root Cause (FIXED): ODL Validation Failure in createEntity

The Palantir refactor (ADR-013) added inline ODL `@link` properties to `createEntity()` calls:

```typescript
// BROKEN (before fix):
const subject = await this.objectManager.create('IntelSubject', {
  ...base,
  person: person._id,           // ← NOT a valid ODL property on IntelSubject
  watchlistStatus: 'NONE',
  isPersonOfInterest: false,
}, ctx);

// Person ODL defines: person: Person! @link(type: "ProfileForPerson")
// @link properties are NOT DB columns. ObjectManager.validate() rejects them.
// Result: createEntity threw → entityId was null → no link attempted.
// entitiesCreated counter was 0. All links failed silently without OBJECT_NOT_FOUND.
```

**Fix applied:** Removed `person: person._id`, `organization: org._id`, `location: loc._id`, `equipment: eq._id` from all `createEntity` calls. Core domain objects and Intel extensions are now created independently without inline linking. ProfileForPerson links are a future concern.

### 2.2 Residual Risk A: Stale Dedup Cache (defense-in-depth)

The `EntityDedupCache` is in-memory (Map, 10k entries, LRU eviction). It survives across individual `processReport` calls within a single container lifecycle but is wiped on container restart. However:

**Scenario — DB cleaned without container restart:**
1. Container running. Entity "Strait of Hormuz" → IntelLocation `loc-abc` created and cached.
2. Administrator runs `DELETE FROM intel_location` manually (or via migration tool).
3. Cache still has `loc-abc` for "Location:strait of hormuz".
4. Next `batchResolve` hits cache → returns `loc-abc`. No DB query.
5. `linkManager.createLink` → `assertObjectExists("IntelLocation", "loc-abc")` → `getObject` returns null → OBJECT_NOT_FOUND.

**Mitigation:** On cache hit, verify the entity ID still exists via lightweight `SELECT "_id" FROM table WHERE "_id" = $1`. If missing, per-key `remove()` and fall through to `createEntity`.

### 2.3 Residual Risk B: Interleaved Create-Link Loop (defense-in-depth)

**Current code** (`processReport` per-entity loop):
```
createEntity() → DB INSERT (connection A)     ← committed here
linkManager.createLink() → DB SELECT (connection B)  ← validates here
```
With PostgreSQL READ COMMITTED, connection B sees connection A's committed writes immediately. No actual inconsistency is possible with a single-instance pool. However, separating the phases eliminates even the theoretical gap and makes the code's intent clearer.

## 3. Solution Selection

### 3.1 Selected: Two-Phase processReport with Per-Key Cache Invalidation

**Phase 1 — Create:** For each entity: validate, batch-resolve dedup, create if new, collect `{ entityId, linkType, linkProps }` into `pendingLinks[]`.

**Phase 2 — Link:** Iterate `pendingLinks[]` and call `linkManager.createLink()` for each. All entity INSERTs are committed before any link validation query runs.

**Per-key invalidation:** `EntityDedupCache.remove(type, name)` removes a single stale key — not the entire cache. `EntityDedupCache.verifyId(type, id)` does a lightweight `SELECT "_id" FROM table WHERE "_id" = $1` to check if a cached entity still exists.

### 3.2 Why the Spec's Original Approach Was Revised

| Original spec proposal | Issue | Revised approach |
|---|---|---|
| `dedupCache.clear()` | Destroys 10k valid entries for 1 stale entry | `remove(type, name)` — per-key invalidation |
| `verifyEntityExists()` via `objectManager.get()` | `ObjectManagerLike` interface lacks `get()` | `verifyId()` on `EntityDedupCache` — uses existing pool query |
| Retry-with-recreate in `catch(linkErr)` | Duplicates `createEntity` logic; risks duplicate entities; complex error handling | Two-phase separation eliminates the gap — no retry needed |
| "Read-after-write consistency gap" | Overstated root cause — PG READ COMMITTED guarantees visibility | Recharacterized as theoretical defense-in-depth |

### 3.3 Why This Is Correct

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Preserves ODL schema | Pass | Links target Intel extensions — `IntelSubject.mentionedIn` works |
| Handles stale cache | Pass | `verifyId()` checks entity existence before using cached ID |
| Eliminates create-link gap | Pass | Two-phase: all creates commit before any link attempt |
| No extra DB reads in happy path | Pass | `verifyId()` only fires on cache hit; two-phase adds zero extra queries |
| No `ObjectManagerLike` change | Pass | Uses existing `StorageProvider.pool` via dedup cache |
| No risk of duplicate entities | Pass | No retry-with-recreate; per-key invalidation falls through to normal create path |
| Minimal code change | Pass | ~120 lines across 4 files, ~30 in core logic |

### 3.4 Alternative Considered: Cache TTL / Periodic Purge

Rejected — adds timer management complexity for a problem the two-phase refactor eliminates.

### 3.5 Alternative Considered: Persistent Cache (Redis)

Rejected — operational complexity, doesn't fix the DB-clean-without-cache-clear scenario.

### 3.6 Alternative Considered: DB UNIQUE Constraint for Dedup

Rejected for this phase — requires schema migration (`UNIQUE ("_tenant_id", "normalized_name") WHERE "_deleted_at" IS NULL`). Considered for future defense-in-depth layer.

## 4. Implementation Summary

Full implementation details in [[ner-link-consistency-fix-plan]].

### 4.1 Key Changes

**EntityDedupCache** — two new methods:
- `remove(type, name)` — per-key cache eviction (3 lines)
- `verifyId(type, id, storage, ctx)` — lightweight `SELECT "_id" FROM table WHERE "_id" = $1` check (~12 lines)

**EntityExtractionService.processReport()** — two-phase restructure (~30 lines):
- Phase 1: validate → dedup → create/reuse → push to `pendingLinks[]`
- Phase 2: iterate `pendingLinks[]` → `linkManager.createLink()`
- Stale-cache guard before phase 1: if `batchResolve` returns cached ID, `verifyId()` it

**No changes to:** `createEntity()`, `linkTypeFor()`, `ObjectManagerLike`, `LinkManagerLike`, ODL schema.

### 4.2 Performance Impact

| Path | Extra DB queries | Frequency |
|------|-----------------|-----------|
| Normal: entity not cached → create + link | 0 extra | Most common (cold start) |
| Normal: entity cached → link only | 1 extra (`verifyId`) | Common (warm cache) |
| Stale cache: `verifyId` fails → create + link | 2 extra (verify + create) | Rare (DB clean w/o restart) |

### 4.3 ODL Preservation

All link targets remain Intel extension IDs (IntelSubject, IntelOrganization, IntelLocation, IntelEquipment, IntelEvent). ODL inbound link traversal (`IntelSubject.mentionedIn`) continues to work.

## 5. Success Criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| 1 | 0 OBJECT_NOT_FOUND errors | `docker logs deploy-api-gateway-1 2>&1 \| grep "OBJECT_NOT_FOUND" \| wc -l` → 0 |
| 2 | 0 orphaned links (all 5 tables) | PSQL: `NOT EXISTS` on intel_subject, intel_organization, intel_location, intel_equipment, intel_event |
| 3 | Stale cache self-heals | Simulate: DELETE entity row → next ingestion recreates entity + link succeeds |
| 4 | Dedup still works | `SELECT "normalized_name", COUNT(*) FROM person GROUP BY "normalized_name" HAVING COUNT(*) > 1` → 0 |
| 5 | All TS tests pass | `cd packages/sync && pnpm run test` → 305+ passed |
| 6 | All existing tests pass unchanged | No test assertions modified or removed |
| 7 | ODL traversal works | `IntelSubject.mentionedIn` returns all linking reports via GraphQL |

## 6. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Two-phase refactor changes behavior in unexpected way | Low | Medium | All existing tests pass without modification. Test assertions are on counts, not order. |
| `verifyId` adds overhead on every cached-entity lookup | Low | Low | One `SELECT _id` per cached hit (< 1ms). Batch resolution already minimizes DB load. |
| Per-key `remove()` doesn't remove the entry fast enough (race with next batchResolve) | Very Low | Low | Same `processReport` call instances the check and invalidation; next call gets fresh state. |

## 7. Open Questions

1. Should `verifyId` fire on EVERY cache hit, or only on the first hit per report batch? (Recommend: every hit — overhead is negligible.)
2. Should we add a UNIQUE constraint on `("_tenant_id", "normalized_name") WHERE "_deleted_at" IS NULL` as a future DB-level defense? (Recommend: revisit after two-phase fix is proven in production.)
3. `IntelEvent` is the correct Intel extension type for Event entities — verified against ODL schema.

## 8. Boundaries

- Always: Run full test suite before deploy. Verify 0 orphans after 5+ minutes of ingestion.
- Ask first: Changes to `linkTypeFor()` mapping. Schema-level dedup via UNIQUE constraints.
- Never: Change `createEntity()` to return core entity IDs. Skip Intel extension creation.

## 9. Commands

```
Test:           cd packages/sync && pnpm run test
Typecheck:      cd packages/sync && pnpm run typecheck
Build+Deploy:   cd deploy && docker compose build --no-cache api-gateway && docker compose up -d
Audit errors:   docker logs deploy-api-gateway-1 2>&1 | grep "OBJECT_NOT_FOUND" | wc -l
Audit orphans:  PGPASSWORD=changeme psql -h localhost -p 5433 -U openfoundry -d openfoundry
                SELECT COUNT(*) FROM mentions_person mp WHERE NOT EXISTS (SELECT 1 FROM intel_subject s WHERE s._id = mp._to_id);
                SELECT COUNT(*) FROM mentions_organization mo WHERE NOT EXISTS (SELECT 1 FROM intel_organization o WHERE o._id = mo._to_id);
                SELECT COUNT(*) FROM mentions_location ml WHERE NOT EXISTS (SELECT 1 FROM intel_location l WHERE l._id = ml._to_id);
                SELECT COUNT(*) FROM mentions_equipment me WHERE NOT EXISTS (SELECT 1 FROM intel_equipment e WHERE e._id = me._to_id);
                SELECT COUNT(*) FROM reported_event re WHERE NOT EXISTS (SELECT 1 FROM intel_event e WHERE e._id = re._to_id);
Audit dedup:    SELECT "normalized_name", COUNT(*) FROM person GROUP BY "normalized_name" HAVING COUNT(*) > 1;
```

## 10. Related Documents

- [[ner-link-consistency-fix-plan]] — Implementation plan: 5 tasks, 3 phases
- [[ner-code-review-findings-spec]] — Original five-axis review that surfaced the link failures
- [[adr-013-palantir-domain-pack-refactor]] — Dual-create pattern that defines link target types
- [[adr-012-ner-python-sidecar]] — In-memory dedup cache tradeoff decision
