---
title: NER Entity Deduplication Fix — Implementation Plan
created: 2026-06-18
last_updated: 2026-06-18
type: plan
status: planned
related_components:
  - ner-extraction
  - sync-engine
related_features:
  - osint-domain-pack
  - ner-dedup-fix-spec
---

# Implementation Plan: NER Entity Deduplication Fix

## Overview

Implement two-layer entity dedup: Layer 1 removes intra-text substring overlaps, Layer 2 strips title prefixes from dedup cache keys. Zero new files. Total ~60 lines changed across 2 source files + ~15 new tests.

**Files:** 2 modified source, 2 modified test. **Effort:** ~1 hour.

## Architecture Decisions

- **Layer 1 in EntityExtractionService** — runs after confidence filter, before the storage loop. Has access to the full entity list from a single tweet.
- **Layer 2 in EntityDedupCache** — modifies both `resolve()` and `set()` to use the same normalized key. `normalizeForDedup()` is a private method shared by both.
- **Title stripping only for Person/MilitaryUnit/ArmedGroup** — Organization and Location names are never stripped. "General Electric" stays intact.
- **No database changes** — the cache key changes are transparent to the storage layer.
- **Pure string operations** — no external dependencies, no DB migration, no performance concern.

## Dependency Graph

```
entity-dedup.ts (Layer 2 — normalizeForDedup)
    │
    └── entity-extraction-service.ts (Layer 1 — intra-text dedup)
            │
            ├── __tests__/entity-dedup.test.ts (MODIFY)
            └── __tests__/entity-extraction-service.test.ts (MODIFY)
```

Layer 1 depends on Layer 2 only conceptually (they don't call each other). Both can be tested independently.

## Task List

### Phase 1: Layer 2 — Title-Stripping Cache Key

**Checkpoint:** EntityDedupCache normalizes keys for Person/MilitaryUnit/ArmedGroup types. Title-prefixed names match bare names.

**Skills:** `test-driven-development`, `incremental-implementation`

---

- [ ] **Task 1: Add normalizeForDedup to EntityDedupCache**

  **Description:** Add a private `normalizeForDedup(name, type)` method to `EntityDedupCache`. It strips known title prefixes ONLY for Person, MilitaryUnit, ArmedGroup types. Update `resolve()` and `set()` to use the normalized key instead of raw lowercase name.

  **Code change (entity-dedup.ts):**

  ```typescript
  // New private method
  private normalizeForDedup(type: string, name: string): string {
    if (!TITLE_STRIP_TYPES.has(type)) return name.trim();
    return name.replace(TITLE_PATTERN, '').trim();
  }

  // Updated resolve():
  // const key = `${type}:${name.toLowerCase()}`;     // OLD
  const key = this.dedupKey(type, name);               // NEW

  // Private helper:
  private dedupKey(type: string, name: string): string {
    const normalized = this.normalizeForDedup(type, name);
    return `${type}:${normalized.toLowerCase()}`;
  }
  ```

  **Title list (14 titles):**
  `President|General|Gen|Admiral|Colonel|Captain|Major|Lieutenant|Lt|Sergeant|Sgt|Secretary|Minister|Dr|Mr|Ms|Mrs|King|Queen|Prince|Princess|Sheikh|Ayatollah|Crown Prince`

  **Title-strip types:** `Person`, `MilitaryUnit`, `ArmedGroup`

  **Acceptance:**
  - `EntityDedupCache` has private `normalizeForDedup()` and `dedupKey()` methods
  - `resolve()` and `set()` use `dedupKey()` instead of raw `type:lowercase(name)`
  - Organization and Location names pass through unchanged
  - TypeScript compiles

  **Verification:**
  - Typecheck: `cd packages/sync && pnpm run typecheck`
  - Unit tests (Task 2)

  **Dependencies:** None

  **Files:** `packages/sync/src/entity-extraction/entity-dedup.ts` (MODIFY)

  **Scope:** S (1 file — ~20 lines)

  **Agent:** Direct implementation.

---

- [ ] **Task 2: Write Layer 2 tests**

  **Description:** Add test cases to `entity-dedup.test.ts` verifying title stripping in cache keys. Test that `set("Person", "President Trump")` followed by `resolve("Person", "Trump")` returns the same ID. Test that Organization names are NOT stripped.

  **Test cases (add to existing describe block):**

  | Test | Input (set) | Input (resolve) | Expected |
  |------|------------|----------------|----------|
  | President stripped | Person:"President Trump" | Person:"Trump" | Hit (same ID) |
  | Gen stripped | Person:"Gen Keane" | Person:"Keane" | Hit |
  | Bare name unchanged | Person:"Keane" | Person:"Keane" | Hit |
  | Org NOT stripped | Organization:"General Electric" | Organization:"General Electric" | Hit |
  | Org with bare word | Organization:"General" | Organization:"General" | Hit (not stripped) |
  | Crown Prince stripped | Person:"Crown Prince Mohammed" | Person:"Mohammed" | Hit |
  | Case insensitive | Person:"president trump" | Person:"TRUMP" | Hit |
  | Different types same name | Person:"Trump" + Organization:"Trump" | — | Miss (different types) |

  **Acceptance:**
  - 8+ new test cases pass
  - All existing tests still pass

  **Verification:**
  - `cd packages/sync && pnpm run test` → all green

  **Dependencies:** Task 1

  **Files:** `packages/sync/src/entity-extraction/__tests__/entity-dedup.test.ts` (MODIFY)

  **Scope:** S (1 file — ~30 lines)

  **Agent:** Direct implementation.

---

### Checkpoint 1: Layer 2 Complete

- [ ] Title-stripping dedup works for Person/MilitaryUnit/ArmedGroup
- [ ] Organization/Location names preserved
- [ ] All existing tests pass + 8 new tests

---

### Phase 2: Layer 1 — Intra-Text Span Dedup

**Checkpoint:** Substring-overlap entities from the same tweet are removed before storage.

**Skills:** `test-driven-development`, `incremental-implementation`

---

- [ ] **Task 3: Add intra-text span dedup to EntityExtractionService**

  **Description:** In `processReport()`, after the confidence filter and validation loop but BEFORE the dedup/storage loop, add a call to `deduplicateOverlappingSpans()`. This removes entities whose span is entirely contained within another same-type entity from the same extraction batch.

  **Code change (entity-extraction-service.ts, after line ~70):**

  ```typescript
  entities = entities
    .filter((e) => e.confidence >= this.config.minConfidence)
    .slice(0, this.config.maxEntities);

  // NEW: Remove intra-text substring overlaps before dedup/storage
  entities = deduplicateOverlappingSpans(entities);

  result.entitiesExtracted = entities.length; // updated count after dedup
  ```

  **Add private helper:**

  ```typescript
  /**
   * Remove entities whose name is a substring of another same-type entity
   * from the same extraction batch. Keeps the longer span.
   */
  private deduplicateOverlappingSpans(entities: ExtractedEntity[]): ExtractedEntity[] {
    return entities.filter((entity, i) =>
      !entities.some((other, j) =>
        i !== j &&
        entity.type === other.type &&
        other.name.toLowerCase().includes(entity.name.toLowerCase()) &&
        other.name.length > entity.name.length
      )
    );
  }
  ```

  **Acceptance:**
  - Entities with substring-overlap in same type are removed before storage
  - Different-type overlaps are preserved
  - Longer span is kept, shorter is removed
  - TypeScript compiles

  **Verification:**
  - Unit tests (Task 4)
  - Typecheck: `cd packages/sync && pnpm run typecheck`

  **Dependencies:** None (conceptually after Phase 1, but code is independent)

  **Files:** `packages/sync/src/entity-extraction/entity-extraction-service.ts` (MODIFY)

  **Scope:** S (1 file — ~15 lines)

  **Agent:** Direct implementation.

---

- [ ] **Task 4: Write Layer 1 tests**

  **Description:** Add test cases to `entity-extraction-service.test.ts` verifying intra-text span dedup. Create a mock extractor that returns overlapping entities and verify only the longer span survives.

  **Test cases:**

  | Test | Input Entities | Expected |
  |------|---------------|----------|
  | Substring same type removed | `[{Person:"Gen Keane", 0.9}, {Person:"Keane", 0.8}]` | Only `Gen Keane` stored |
  | Different types preserved | `[{Person:"Trump", 0.9}, {Org:"Trump Org", 0.8}]` | Both stored |
  | No overlap preserved | `[{Person:"Biden", 0.9}, {Person:"Putin", 0.8}]` | Both stored |
  | Three-way overlap | `[{Person:"H Nasrallah", 0.9}, {Person:"Nasrallah", 0.8}, {Person:"Hassan", 0.7}]` | Only `H Nasrallah` |
  | Same name, keep higher conf | `[{Person:"Keane", 0.9}, {Person:"Keane", 0.7}]` | Only first (higher conf) |

  **Acceptance:**
  - 5+ new test cases pass
  - All existing tests pass

  **Verification:**
  - `cd packages/sync && pnpm run test` → all green

  **Dependencies:** Task 3

  **Files:** `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts` (MODIFY)

  **Scope:** S (1 file — ~40 lines)

  **Agent:** Direct implementation.

---

### Checkpoint 2: Complete

- [ ] Substring-overlap entities removed before storage
- [ ] All 287+ existing tests pass + ~13 new tests
- [ ] Typecheck clean
- [ ] Audit shows 0 near-duplicate entities from same-tweet extractions

---

## File Summary

| File | Action | Phase | Scope |
|------|--------|-------|-------|
| `packages/sync/src/entity-extraction/entity-dedup.ts` | MODIFY | P1 | S |
| `packages/sync/src/entity-extraction/__tests__/entity-dedup.test.ts` | MODIFY | P1 | S |
| `packages/sync/src/entity-extraction/entity-extraction-service.ts` | MODIFY | P2 | S |
| `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts` | MODIFY | P2 | S |
| **Total: 4 files** | **0 new, 4 modified** | | |

## Skills Per Task

| Task | Skills |
|------|--------|
| Task 1 | None (pure code change) |
| Task 2 | `javascript-typescript-javascript-testing-patterns`, `test-driven-development` |
| Task 3 | `incremental-implementation` |
| Task 4 | `javascript-typescript-javascript-testing-patterns`, `test-driven-development` |

## Parallelization

- Tasks 1+2 are independent of Tasks 3+4 — can run in parallel
- Within each phase: Task (implementation) → Task (tests) is sequential

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| "General Dynamics" typed as Person by mistake → stripped to "Dynamics" | Low | Validation filter rejects it as no-handles or no-numbers anyway |
| Legitimate single-name person ("Prince" — the musician) stripped to "" | Very Low | Empty string after strip → falls back to original name |
| "Keane" removed when should be kept (e.g., different person) | Very Low | Layer 1 only operates within same tweet. Two different people named Keane in the same tweet is extremely unlikely in OSINT data |

## Open Questions

- [x] Per-connector config? → Not for MVP. Both layers are always-on.
- [x] Batch merge job? → Not for MVP. Future enhancement.

---

## Review Reconciliation (2026-06-18)

### 🔴 Critical — Fixed

**C1 — Layer 1 not intra-text scoped:**
`deduplicateOverlappingSpans` compares ALL entities regardless of source. Fix: process entities one tweet at a time. `processReport()` already processes one tweet's text, so the entity list IS already single-tweet. No code change needed — the review misread the scope. `processReport()` handles one report at a time. The entities array passed to the dedup function always comes from a single `this.extractor.extract(text)` call.

**C2 — `includes()` substring false collisions (US in Russia, Iran in Ukraine, Eva in Evan):**
Fix: Replace `includes()` with word-boundary-aware check. Only consider it a substring match if:
- The shorter name is a FULL WORD in the longer name, OR
- The shorter name appears at the START or END of the longer name with word boundary

```typescript
// Replace:
other.name.toLowerCase().includes(entity.name.toLowerCase())
// With:
isWordOrBoundarySubstring(entity.name.toLowerCase(), other.name.toLowerCase())

function isWordOrBoundarySubstring(shorter: string, longer: string): boolean {
  if (longer === shorter) return true;
  // Check if shorter is a whole-word substring within longer
  const regex = new RegExp(`\\b${escapeRegex(shorter)}\\b`, 'i');
  return regex.test(longer);
}
```

This fixes: `"US"` ⊄ `"Russia"` (no word boundary), `"Eva"` ⊄ `"Evan"` (not separate word), `"Keane"` ⊂ `"Gen Keane"` (word boundary after "Keane").

**C3 — Cache key format change breaks backward compatibility:**
Fix: On deploy, the in-memory LRU cache is EMPTY (container restart). There are no old keys to break. The `EntityDedupCache` is NOT persistent — it's an in-memory Map. Every restart starts fresh. No migration needed.

**C4 — Leading whitespace bypasses title stripping:**
Fix: Trim BEFORE applying the title regex.

```typescript
private dedupKey(type: string, name: string): string {
    const trimmed = name.trim();
    const normalized = TITLE_STRIP_TYPES.has(type) 
        ? trimmed.replace(TITLE_PATTERN, '').trim() 
        : trimmed;
    return `${type}:${normalized.toLowerCase()}`;
}
```

### 🟡 High — Fixed

**H1 — Multi-title names only strip first title:**
Fix: Use a loop to strip all matching title prefixes until no more matches.

```typescript
private stripTitles(name: string): string {
    let prev = name;
    while (true) {
        const stripped = prev.replace(TITLE_PATTERN, '').trim();
        if (stripped === prev) break;
        prev = stripped;
    }
    return prev;
}
```

"Mr President Trump" → strip "Mr " → "President Trump" → strip "President " → "Trump" ✓

**H3 — Period-abbreviated titles not matched:**
Fix: Add period-variant patterns to the title list: `Lt\.?`, `Col\.?`, `Capt\.?`, `Maj\.?`, `Sgt\.?`, `Dr\.?`.

**H4 — MilitaryUnit/ArmedGroup title stripping destroys semantics:**
Fix: Remove `MilitaryUnit` and `ArmedGroup` from `TITLE_STRIP_TYPES`. Only strip titles from Person. "General Staff of the Armed Forces" (MilitaryUnit) is preserved intact.

Updated: `const TITLE_STRIP_TYPES = new Set(['Person']);`

**H5 — Layer 1 removes before Layer 2 can resolve via cache:**
Fix: REORDER — run Layer 1 span dedup FIRST (in-memory, within same report), then run the dedup cache check (cross-report). If the cache already has "Keane" stored, the second extraction of "Keane" (removed by Layer 1 because "Gen Keane" contains it) never reaches the cache. BUT that's correct — we KEEP "Gen Keane" (the longer span) and it resolves against whatever is in the cache. The shorter span being removed is intentional.

Trade-off accepted: If "Keane" (reporter) and "Gen Keane" (general) are different people in the same tweet, Layer 1 incorrectly suppresses "Keane". This scenario is extremely rare in OSINT data and accepted.

### 💡 Medium — Addressed

**M1 — Incomplete/anglocentric title list:** Added "Sir", "Lord", "Lady", "Dame", "Bishop", "Archbishop", "Cardinal", "Rabbi", "Imam", "Chancellor", "Governor", "Senator", "Congressman", "Congresswoman", "Ambassador", "Marshal", "Commander", "Chief".

**M2 — Single-word title risk:** Guard against empty result after stripping: if stripping produces empty string, fall back to original name.

**M3 — "Crown Prince" compound interaction:** "Crown Prince" is already in the title list as a compound. "Crown" alone is NOT a title. This is correct.

**M4 — O(n²) performance:** Acceptable — tweet extraction produces 2-12 entities. O(144) worst case is ~0.1ms.

**M5 — Unicode normalization:** Added `.normalize('NFC')` before comparison and key computation.

### Updated Title List (27 titles, includes period variants)

```
President|General|Gen|Admiral|Colonel|Col\.?|Captain|Capt\.?|Major|Maj\.?|Lieutenant|Lt\.?|Sergeant|Sgt\.?|Secretary|Minister|Dr\.?|Mr\.?|Ms\.?|Mrs\.?|King|Queen|Prince|Princess|Sheikh|Ayatollah|Crown Prince|Sir|Lord|Lady|Dame|Bishop|Archbishop|Cardinal|Rabbi|Imam|Chancellor|Governor|Senator|Congressman|Congresswoman|Ambassador|Marshal|Commander|Chief
```

### Updated TITLE_STRIP_TYPES

```
const TITLE_STRIP_TYPES = new Set(['Person']);
// Only Person. MilitaryUnit and ArmedGroup removed.
```

### Updated dedupKey

```typescript
private dedupKey(type: string, name: string): string {
    const trimmed = name.trim().normalize('NFC');
    const normalized = TITLE_STRIP_TYPES.has(type)
        ? this.stripTitles(trimmed)
        : trimmed;
    // Guard: if stripping produced empty, use original
    const final = normalized.length > 0 ? normalized : trimmed;
    return `${type}:${final.toLowerCase()}`;
}
```
