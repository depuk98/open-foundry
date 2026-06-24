---
title: NER Link Consistency Fix — Implementation Plan
created: 2026-06-20
last_updated: 2026-06-20
type: feature
status: planned
related_components:
  - ner-extraction
  - sync-engine
related_features:
  - osint-domain-pack
  - ner-link-consistency-fix-spec
related_decisions:
  - adr-013-palantir-domain-pack-refactor
  - adr-012-ner-python-sidecar
---

# NER Link Consistency Fix — Implementation Plan

> **This is the implementation plan.** See [[ner-link-consistency-fix-spec]] for root cause analysis, tradeoff comparison, and solution rationale.

## Overview

Fix intermittent `OBJECT_NOT_FOUND` errors when `linkManager.createLink()` validates a target entity that was just created. The root cause: the link creation validation runs on a different connection pool session than the entity creation, and stale dedup cache entries after DB-cleaning operations can survive. The fix separates entity creation from link creation into two phases, eliminating the read-after-write gap, and adds per-key cache invalidation for stale entries.

## Architecture Decision

**Two-phase approach**: Separate `createEntity` calls from `linkManager.createLink` calls. All entity creation commits happen in phase 1. All link creation happens in phase 2. This guarantees that every entity referenced by a link is fully committed before the link's referential integrity check runs.

**Per-key invalidation**: Add `EntityDedupCache.remove()` to invalidate a single stale entry. The spec proposed `clear()` (destroy entire 10k-entry cache), which is too destructive. Per-key invalidation targets only the stale entry; valid entries remain cached.

**No `ObjectManagerLike` interface changes needed**: The fix uses existing `EntityDedupCache` methods. Stale detection uses a new `verifyId()` method on the cache itself (lightweight `SELECT _id` query), not `objectManager.get()` (which doesn't exist on the injected interface).

### Defense-in-depth layers

The fix provides two complementary guarantees:

**Layer 1 — Stale cache recovery:** On `batchResolve` cache hit, `verifyId()` confirms the entity still exists in the DB. If deleted, per-key `remove()` evicts the stale entry and `createEntity` creates a fresh one. Handles Scenario B (DB clean without container restart).

**Layer 2 — Create-link gap elimination:** Phase 1 commits all `createEntity` INSERTs. Phase 2 creates links — all targets are guaranteed visible. Eliminates even the theoretical gap. Handles Scenario C (defense-in-depth).

### Why not the spec's proposed approach?

| Spec proposal | Issue | Our approach |
|---|---|---|
| `dedupCache.clear()` | Wipes 10k valid entries | Per-key `remove()` |
| `verifyEntityExists()` via `objectManager.get()` | `ObjectManagerLike` lacks `get()` | Use existing `queryByName()` in dedup cache |
| Retry-with-recreate-in-catch | Duplicates entity creation logic; risk of duplicates | Separate phases eliminate the gap |

## Task List

### Phase 1: Cache enhancement

#### Task 1: Add `remove()` method to `EntityDedupCache`

**Description:** Add a public `remove(type, name)` method that removes a single key from the in-memory cache. This is the safe substitute for `clear()` — only the stale entry is evicted, not the entire 10k-entry cache.

**Acceptance criteria:**
- [ ] `dedupCache.remove('Person', 'Stale Name')` removes the matching cache key
- [ ] Calling `remove` for a key not in cache is a no-op (no error thrown)
- [ ] After `remove`, subsequent `resolve` for the same type+name returns `null` (cache miss) and falls through to DB
- [ ] `cache.size` decrements correctly

**Verification:**
- [ ] Tests pass: `cd packages/sync && pnpm run test`
- [ ] New unit test in `entity-dedup.test.ts` covering: remove existing key, remove missing key (no-op), size after remove

**Dependencies:** None

**Files touched:**
- `packages/sync/src/entity-extraction/entity-dedup.ts` (~3 lines)
- `packages/sync/src/entity-extraction/__tests__/entity-dedup.test.ts` (~20 lines)

**Estimated scope:** XS (1 method + 3 tests)

---

#### Task 2: Add lightweight stale-entry detection via `verifyId()`

**Description:** After `batchResolve` returns a cached entity ID, verify it still exists in the DB before using it for link creation. If the entity was deleted (DB clean without cache eviction), remove the stale key via `remove()` and fall through to `createEntity()` for a fresh entity.

Add `verifyId(type, id, storage, ctx)` to `EntityDedupCache` — a lightweight `SELECT "_id" FROM table WHERE "_tenant_id" = $1 AND "_id" = $2 AND "_deleted_at" IS NULL` check. This is distinct from `queryByName()` (which queries by `normalized_name`, not `_id`). `queryByName` is for dedup resolution; `verifyId` is for existence validation of already-resolved IDs.

**Layer 1 defense:** The stale-cache check fires when a `batchResolve` hit comes from the in-memory cache (not from a fresh DB query). A DB-resolved hit is already verified — the DB just told us it exists.

**Layer 2 defense:** The two-phase refactor (Task 3) eliminates the create-link timing gap — the primary guarantee that entities exist before links are created.

**Acceptance criteria:**
- [ ] `dedupCache.verifyId('Person', 'some-id', storage, ctx)` returns `true` for existing entity
- [ ] Returns `false` for deleted/nonexistent entity
- [ ] When `verifyId` returns false AND the cache had the entry, the stale key is removed and entity is recreated
- [ ] When `verifyId` returns true, processing continues normally (no extra work)
- [ ] SQL query is a lightweight `SELECT "_id"` with indexed lookup, not a full object load

**Verification:**
- [ ] Tests pass: `cd packages/sync && pnpm run test`
- [ ] New unit test in `entity-dedup.test.ts`: `verifyId` returns true for existing, false for missing
- [ ] New integration test in `entity-extraction-service.test.ts`: simulate stale cache entry → entity recreated, link succeeds

**Dependencies:** Task 1

**Files touched:**
- `packages/sync/src/entity-extraction/entity-dedup.ts` (~15 lines for `verifyId`)
- `packages/sync/src/entity-extraction/entity-extraction-service.ts` (~10 lines in `processReport` loop)
- `packages/sync/src/entity-extraction/__tests__/entity-dedup.test.ts` (~15 lines, 2 new tests)
- `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts` (~25 lines, 2 new tests)

**Estimated scope:** S (1 method + 4 tests)

---

### Checkpoint: Cache Enhancement
- [ ] `EntityDedupCache.remove()` and `verifyExists()` work correctly
- [ ] All existing 305 tests + new tests pass
- [ ] TypeScript compilation clean: `cd packages/sync && pnpm run typecheck`

---

### Phase 2: Two-phase processReport

#### Task 3: Separate entity creation from link creation in `processReport`

**Description:** The core fix. Split the per-entity loop into two sequential phases:

**Phase 1 (create/reuse):** For each entity: validate, dedup check, create if new, collect `{ entityId, linkType, linkProps }` into a `pendingLinks` array.

**Phase 2 (link):** Iterate `pendingLinks` and call `linkManager.createLink()` for each. All entities are guaranteed committed by this point.

No retry logic needed — the separation eliminates the timing gap that caused the intermittent failure. A single catch per link still fires for genuine errors (e.g., `fromId` / IntelReport doesn't exist, schema mismatch).

**Acceptance criteria:**
- [ ] `entitiesCreated` count matches pre-change behavior (no regression)
- [ ] `linksCreated` count matches pre-change behavior
- [ ] `entitiesDedupHit` count matches pre-change behavior
- [ ] Link creation errors are still caught per-link (one bad link doesn't block others)
- [ ] Error logging preserves entity type, name, reportId context
- [ ] `ReportedEvent` links get `{ relationship_type: 'mentioned' }`, all others get `{ context, confidence }` (preserved from prior fix)
- [ ] `result.entitiesCreated` increments in phase 1, `result.linksCreated` in phase 2

**Verification:**
- [ ] Tests pass: `cd packages/sync && pnpm run test`
- [ ] Existing tests for correct link types, dedup behavior, entity counts all pass without modification
- [ ] New test: simulate linkManager throwing on second link → first link still created, error counted, third link still attempted

**Dependencies:** Tasks 1, 2

**Files touched:**
- `packages/sync/src/entity-extraction/entity-extraction-service.ts` (restructure lines 114-162)
- `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts` (~30 lines, 2 new tests)

**Estimated scope:** M (refactor ~50 lines, add 2 tests)

---

#### Task 4: Preserve existing error isolation and metrics

**Description:** Audit and preserve the existing behavior guarantees:
- Per-entity validation failures don't block other entities (`entitiesRejected++`, `continue`)
- Per-entity creation failures are caught and logged with context
- Per-link creation failures are caught and logged (even with two-phase refactor)
- `entitiesExtracted` is set before any entity processing
- Short text guard still returns early with zero counts
- Extractor failure still returns early

**Acceptance criteria:**
- [ ] All existing test assertions pass unchanged (no behavioral regressions)
- [ ] Error counter increments correctly when a single entity creation fails
- [ ] Error counter increments correctly when a single link creation fails
- [ ] Other entities' links are created even if one link fails (isolation)

**Verification:**
- [ ] Tests pass: `cd packages/sync && pnpm run test`
- [ ] Review: no existing test assertions removed or weakened

**Dependencies:** Task 3

**Files touched:**
- `packages/sync/src/entity-extraction/entity-extraction-service.ts` (review only)
- `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts` (new test for link failure isolation)

**Estimated scope:** S (review + 1 new test)

---

### Checkpoint: Two-Phase Refactor
- [ ] `processReport` uses separate create + link phases
- [ ] All 305+ existing tests pass with zero modifications
- [ ] New tests cover: stale cache recovery, link failure isolation, two-phase ordering
- [ ] TypeScript compilation clean

---

### Phase 3: Integration verification

#### Task 5: Docker deployment smoke test

**Description:** Rebuild the API gateway with the two-phase fix, deploy, and verify end-to-end:
- Zero `OBJECT_NOT_FOUND` errors in logs after 5+ minutes of continuous ingestion
- All link tables populated (`mentions_person`, `mentions_organization`, etc.)
- Entity dedup still works (no duplicate `normalized_name` values)
- `reported_event` links have `relationship_type` column populated

**Acceptance criteria:**
- [ ] `docker logs deploy-api-gateway-1 2>&1 | grep "OBJECT_NOT_FOUND" | wc -l` → 0
- [ ] `SELECT COUNT(*) FROM mentions_person mp WHERE NOT EXISTS (SELECT 1 FROM intel_subject s WHERE s._id = mp._to_id)` → 0 (zero orphans)
- [ ] No duplicate `normalized_name` in any domain table
- [ ] `entitiesCreated > 0` and `linksCreated > 0` in NER logs

**Verification:**
- [ ] `cd deploy && docker compose build --no-cache api-gateway && docker compose up -d`
- [ ] Wait 5+ minutes, run audit queries
- [ ] PSQL audit commands from spec

**Dependencies:** Tasks 1-4 complete, all tests passing

**Files touched:** None (existing Docker config)

**Estimated scope:** S (deploy + verify, no code)

---

## Task Dependency Graph

```
Task 1 (remove method) ──┐
                          ├── Task 3 (two-phase refactor) ──┬── Task 4 (isolation audit)
                          │                                 │
Task 2 (stale detection) ─┘                                 └── Task 5 (smoke test)
```

Tasks 1 and 2 can be done in parallel (different files, independent concerns).
Task 3 depends on both 1 and 2.
Task 4 depends on 3.
Task 5 is the final gate.

## Files Changed Summary

| File | Task | Type | Lines |
|------|------|------|-------|
| `packages/sync/src/entity-extraction/entity-dedup.ts` | 1, 2 | add `remove()` + `verifyExists()` | ~15 |
| `packages/sync/src/entity-extraction/entity-extraction-service.ts` | 2, 3 | stale detection + two-phase refactor | ~30 |
| `packages/sync/src/entity-extraction/__tests__/entity-dedup.test.ts` | 1 | 3 new tests for `remove()` | ~20 |
| `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts` | 2, 3, 4 | stale cache + two-phase + isolation tests | ~55 |

Total: ~120 lines of code/tests across 4 files. No schema changes. No new dependencies.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Two-phase refactor changes timing and exposes a different race | Low | Medium | All creates complete before links. PostgreSQL READ COMMITTED guarantees visibility. |
| `verifyExists` adds one DB query per cached entity on cold start | Low | Low | Only fires on cache hits that haven't been verified recently. BatchResolve already minimizes DB load. |
| Existing tests rely on per-entity create+link ordering | Low | Medium | Tests assert on counters and link types, not order. Verified — no tests check createLink call sequence. |
| ReportedEvent link type has different properties schema | Low | High | Preserved from prior fix — conditional `linkProps` assignment already in code. |

## Open Questions

1. Should `verifyExists` be called on EVERY cache hit, or only on the first hit per cache-warming cycle? (Recommend: every hit for simplicity; the overhead is one `SELECT _id` which is ~0.1ms.)

2. Should we add a TTL-based periodic invalidation as defense-in-depth? (Recommend: no — adds complexity for a problem that the two-phase refactor eliminates. Revisit if OBJECT_NOT_FOUND returns on deployments with DB cleaning.)

## Commands

```
TS tests:       cd packages/sync && pnpm run test
TS typecheck:   cd packages/sync && pnpm run typecheck
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
