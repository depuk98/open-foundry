---
title: NER Data Quality Fix — Implementation Plan
created: 2026-06-18
last_updated: 2026-06-18
type: plan
status: planned
related_components:
  - ner-extraction
  - sync-engine
  - api-gateway
related_features:
  - osint-domain-pack
  - ner-data-quality-audit
  - ner-data-quality-fix-spec
---

# Implementation Plan: NER Data Quality Fix

## Overview

Insert a pre-storage validation layer into `EntityExtractionService` that cleans and validates every entity before it reaches `createEntity()`. Invalid entities are rejected with a logged reason and counted in a metric. Valid entities are cleaned (possessives, punctuation, emoji). The filter is configurable per-connector via YAML.

**Files:** 6 new, 4 modified. **Effort:** ~3 hours.

## Architecture Decisions

- **Single integration point:** `EntityExtractionService.processReport()` — between line 70 (confidence filter) and line 72 (storage loop). One place to validate everything.
- **Clean then validate:** Cleaning transformations run first (strip possessives, normalize case). Cleaned entity is then validated. If cleaning produces empty string → reject.
- **Rule composition:** Each rule is `{ name, check }`. Rules are arrays per entity type. Adding a new rule = appending to the array.
- **Per-connector config:** `EntityExtractionConfig` in YAML connector config grows a `validation` object. Omitted = all rules enabled.
- **Rejection metric:** `EntityExtractionResult.entitiesRejected` counter. Logged with reason at DEBUG.
- **No entity mutation before storage:** Validation rejects invalid entities. Cleaning mutates the entity name before validation but never changes the type or confidence.

## Dependency Graph

```
entity-validation.ts (NEW)        ← All rules live here
    │
    ├── types.ts (MODIFY)          ← ExtractedEntity gets `cleanedName`?
    │   └── EntityExtractionResult gets `entitiesRejected`
    │
    ├── entity-extraction-service.ts (MODIFY)  ← Call validation in processReport()
    │   └── Constructor takes optional ValidationConfig
    │
    ├── mapping-parser.ts (MODIFY)  ← EntityExtractionConfig gets `validation?`
    │
    ├── entity-validation.test.ts (NEW)  ← 30+ tests for all rules
    │
    └── server.ts (MODIFY)          ← Pass validation config from YAML to service
```

## Task List

### Phase 1: Validation Module + Types

**Checkpoint:** Validation module builds, types are extended, all rules have tests.

**Skills:** `test-driven-development`, `incremental-implementation`, `python-development` languages replaced with TypeScript equivalents

**Subagents:** Use `task` tool with `agent-teams__team-implementer` for parallel test writing.

---

- [ ] **Task 1: Extend types to support validation**

  **Description:** Add `entitiesRejected` counter to `EntityExtractionResult`. Add `ValidationConfig` and `ValidationRuleConfig` interfaces to `types.ts` and `mapping-parser.ts`. Extend `EntityExtractionConfig` with optional `validation` field.

  **Acceptance:**
  - `EntityExtractionResult` has `entitiesRejected: number` field
  - `EntityExtractionConfig` has optional `validation?: { enabled: boolean; clean?: {...}; rules?: {...} }`
  - TypeScript compiles without errors
  - Existing test files still compile

  **Verification:**
  - `cd packages/sync && pnpm run typecheck` → clean

  **Dependencies:** None

  **Files:** `packages/sync/src/entity-extraction/types.ts` (MODIFY), `packages/sync/src/mapping/mapping-parser.ts` (MODIFY)

  **Scope:** S (2 files)

  **Agent:** Direct implementation. Load `typescript` patterns from `javascript-typescript-typescript-advanced-types`.

---

- [ ] **Task 2: Create entity-validation.ts — Cleaning functions**

  **Description:** Implement 6 cleaning transformations. Each is a pure function: takes entity name string, returns cleaned string. If cleaning produces empty string, return null (caller rejects).

  Cleaning functions:
  - `stripPossessive(name)` — `"Beirut's"` → `"Beirut"`
  - `stripTrailingPunct(name)` — `"Washington."` → `"Washington"`
  - `stripEmoji(name)` — `"🔥Ukraine🔥"` → `"Ukraine"`
  - `stripQuotes(name)` — `'"NATO"'` → `"NATO"`
  - `normalizeWhitespace(name)` — `"New  York"` → `"New York"`
  - `cleanEntityName(name, config)` — applies all enabled cleaners in order, returns cleaned name or null

  **Acceptance:**
  - Each function is independently testable
  - `cleanEntityName` returns null if result is empty
  - All cleaners respect the per-connector config (can be individually disabled)
  - TypeScript compiles

  **Verification:**
  - Write unit tests (Task 4 covers this)
  - Quick manual test: `console.log(stripPossessive("Beirut's"))` → `"Beirut"`

  **Dependencies:** Task 1

  **Files:** `packages/sync/src/entity-extraction/entity-validation.ts` (NEW)

  **Scope:** S (1 file)

  **Agent:** Direct implementation.

---

- [ ] **Task 3: Create entity-validation.ts — Validation rules**

  **Description:** Implement 19 validation rules across 4 entity types as composable `ValidationRule[]` arrays. Each rule returns `{valid: true}` or `{valid: false, reason: string}`.

  Rule implementation pattern:
  ```typescript
  const PERSON_RULES: ValidationRule[] = [
    { name: 'no-handles', check: (e) => { ... } },
    { name: 'no-numbers', check: (e) => { ... } },
    // ...
  ];
  const RULES_BY_TYPE: Record<string, ValidationRule[]> = {
    Person: PERSON_RULES,
    Organization: ORG_RULES,
    Equipment: EQUIPMENT_RULES,
    Location: LOCATION_RULES,
    // Event, WeaponSystem, etc. inherit from base types
  };
  ```

  Export `validateEntity(entity, sourceText, enabledRules?)` — entry point that cleans first, then validates against enabled rules. Returns `{valid, entity?, reason?}`.

  **Acceptance:**
  - All 19 rules implemented (5 Person, 4 Org, 5 Equipment, 3 Location, + mapped types)
  - Mapped types (WeaponSystem→Equipment, MilitaryUnit→Org, etc.) use their parent's rules
  - `validateEntity` cleans before validating
  - `validateEntity` returns cleaned entity on success
  - Unknown types pass through with no validation (future-proof)

  **Verification:**
  - Unit tests (Task 4)
  - Each rule tested with at least 1 positive and 1 negative case

  **Dependencies:** Task 2

  **Files:** `packages/sync/src/entity-extraction/entity-validation.ts` (MODIFY — add rules)

  **Scope:** M (1 file — ~200 lines)

  **Agent:** Direct implementation. Load `test-driven-development` skill.

---

- [ ] **Task 4: Create entity-validation.test.ts — Full test coverage**

  **Description:** Write vitest tests covering every cleaning function and every validation rule. Minimum 2 tests per rule (valid + invalid). Test edge cases: empty strings, Unicode, special characters, mapped types.

  **Test structure:**
  ```typescript
  describe('cleanEntityName', () => {
    it('strips possessive', ...)
    it('strips trailing punctuation', ...)
    it('returns null for emoji-only name', ...)
  });
  describe('Person rules', () => {
    describe('no-handles', () => {
      it('rejects lowercase single-word names', ...)
      it('accepts capitalized names', ...)
      it('accepts two-word names', ...)
    });
    // ...
  });
  // similar for Organization, Equipment, Location
  describe('validateEntity integration', () => {
    it('cleans then validates', ...)
    it('respects disabled rules', ...)
    it('passes through unknown types', ...)
  });
  ```

  **Acceptance:**
  - 30+ tests covering all rules
  - Each rule has at least 1 positive (accept) and 1 negative (reject) test
  - Cleaning tests cover all 6 transformations
  - Integration test covers clean→validate pipeline
  - All tests pass: `pnpm run test`

  **Verification:**
  - `cd packages/sync && pnpm run test` → all green including new tests

  **Dependencies:** Task 3

  **Files:** `packages/sync/src/entity-extraction/__tests__/entity-validation.test.ts` (NEW)

  **Scope:** M (1 file — ~150 lines)

  **Agent:** Use `task` with `agent-teams__team-implementer` subagent. Load `javascript-typescript-javascript-testing-patterns` skill.

---

### Checkpoint 1: Validation Module Complete

- [ ] `entity-validation.ts` exports `validateEntity` and `cleanEntityName`
- [ ] 30+ tests pass covering all rules
- [ ] TypeScript typecheck clean
- [ ] All existing 209 tests still pass (no regression)

---

### Phase 2: Integration

**Checkpoint:** Validation filter wired into EntityExtractionService, rejects flow through server.ts.

**Skills:** `incremental-implementation`

---

- [ ] **Task 5: Integrate validation into EntityExtractionService**

  **Description:** Modify `EntityExtractionService.processReport()` to call `validateEntity()` on each entity before storage. Rejected entities increment `entitiesRejected` counter and are skipped (continue to next entity). Send the cleaned entity name to `createEntity()` and `dedupCache`.

  **Code change (entity-extraction-service.ts, in processReport(), after line 70):**
  ```typescript
  // Store the source text for validation
  const sourceText = text;
  
  for (const entity of entities) {
    try {
      // Validate and clean entity before storage
      const validation = validateEntity(entity, sourceText, this.validationConfig);
      if (!validation.valid) {
        result.entitiesRejected++;
        continue; // skip this entity
      }
      // Use cleaned entity for storage
      const cleanEntity = validation.entity ?? entity;
      let entityId = await this.dedupCache.resolve(
        cleanEntity.type, cleanEntity.name, this.storage, ctx,
      );
      // ... rest unchanged
  ```

  Constructor takes optional `ValidationConfig` parameter. The `EntityExtractionServiceConfig` is extended with `validation?: ValidationRuleConfig`.

  **Acceptance:**
  - `validateEntity()` called on every entity before `createEntity()`
  - Rejected entities increment `entitiesRejected` and are skipped
  - Clean entity name used for dedup + storage
  - Service works without validation config (all rules enabled by default)
  - Existing tests continue to pass (mock entities don't trigger rules)

  **Verification:**
  - Typecheck clean
  - Existing 209 tests pass (no regression)
  - Manual: create a service with a mocked extractor returning `["ChristopherJM"]` → entity rejected

  **Dependencies:** Task 3, Task 4

  **Files:** `packages/sync/src/entity-extraction/entity-extraction-service.ts` (MODIFY)

  **Scope:** S (1 file — ~20 lines changed)

  **Agent:** Direct implementation.

---

- [ ] **Task 6: Create validation test for EntityExtractionService**

  **Description:** Add test cases to existing `entity-extraction-service.test.ts` that verify:
  - Handle-like entity is rejected, `entitiesRejected` incremented
  - Valid entity passes through
  - Cleaning transforms entity name
  - Per-connector rule disable works

  **Acceptance:**
  - Test: service with mock extractor returning `"ChristopherJM"` → result.entitiesRejected = 1, result.entitiesCreated = 0
  - Test: service with mock extractor returning `"Zelensky"` → result.entitiesCreated = 1, result.entitiesRejected = 0
  - Test: cleaning strips `"Beirut's"` → stored as `"Beirut"`
  - Test: disabled rules don't reject otherwise-invalid entities

  **Verification:**
  - `pnpm run test` → new tests pass

  **Dependencies:** Task 5

  **Files:** `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts` (MODIFY)

  **Scope:** S (1 file — ~30 lines added)

  **Agent:** Direct implementation.

---

### Checkpoint 2: Integration Complete

- [ ] EntityExtractionService validates every entity before storage
- [ ] Rejected entities logged with reason
- [ ] Tests prove handle rejection, valid acceptance, cleaning
- [ ] All tests pass

---

### Phase 3: Wiring + Per-Connector Config

**Checkpoint:** Config flows from YAML → EntityExtractionService. Deployed and audited.

**Skills:** `incremental-implementation`, `ci-cd-and-automation`

---

- [ ] **Task 7: Wire validation config from YAML**

  **Description:** The `EntityExtractionConfig` type in `mapping-parser.ts` already has the validation field (added in Task 1). Parse it from the `twitter-osint.yaml` entityExtraction section. Pass to `EntityExtractionService` constructor in `server.ts`.

  **server.ts change:** When creating `EntityExtractionService`, read `mappingConfig.entityExtraction?.validation` and pass it:
  ```typescript
  entityExtractionService = new EntityExtractionService(
    compositeExtractor, entityDedupCache, objectManager, linkManager, storage,
    { minConfidence: 0.4, maxEntities: 20, minTextLength: 30 },
    mappingConfig.entityExtraction?.validation,  // NEW
  );
  ```

  **Acceptance:**
  - Validation config flows from YAML → mapping parser → server.ts → EntityExtractionService
  - If YAML doesn't specify validation config, defaults apply (all rules enabled)
  - If YAML specifies `validation.enabled: false`, no validation runs

  **Verification:**
  - Typecheck clean
  - Rebuild API gateway: `docker compose build api-gateway && docker compose up -d api-gateway`

  **Dependencies:** Task 5

  **Files:** `packages/api/src/server.ts` (MODIFY)

  **Scope:** S (1 file — ~5 lines changed)

  **Agent:** Direct implementation.

---

- [ ] **Task 8: Add validation section to twitter-osint.yaml**

  **Description:** Add `entityExtraction.validation` block to `domain-packs/osint/connectors/twitter-osint.yaml` with all rules explicitly enabled (default behavior, but explicit = auditable).

  **YAML addition:**
  ```yaml
  entityExtraction:
    enabled: true
    types: [...]
    minConfidence: 0.4
    validation:
      enabled: true
      clean:
        stripPossessive: true
        stripTrailingPunct: true
        stripEmoji: true
        stripQuotes: true
        normalizeWhitespace: true
      rules:
        person:
          - no-handles
          - no-numbers
          - no-titles-only
          - min-length
        organization:
          - no-handles
          - no-roles
          - no-generic-nouns
          - min-length
        equipment:
          - no-commercial
          - no-alert-systems
          - no-generic-only
          - no-truncated
          - min-designation
        location:
          - no-descriptions
          - min-length
  ```

  **Acceptance:**
  - YAML parses without errors
  - All rules listed explicitly

  **Verification:**
  - `python -c "import yaml; yaml.safe_load(open('domain-packs/osint/connectors/twitter-osint.yaml'))"` → no errors

  **Dependencies:** Task 1

  **Files:** `domain-packs/osint/connectors/twitter-osint.yaml` (MODIFY)

  **Scope:** S (1 file)

  **Agent:** Direct implementation.

---

- [ ] **Task 9: Deploy and audit**

  **Description:** Rebuild API gateway Docker image, clean database, restart stack, wait for one full extraction cycle, re-run the audit SQL.

  **Steps:**
  1. `docker compose build api-gateway`
  2. `docker compose up -d api-gateway`
  3. Clean DB: delete all person/org/location/equipment/event + mentions links
  4. Wait 5+ minutes for extraction cycle
  5. Run audit SQL from `ner-data-quality-audit.md`
  6. Verify metrics: handles < 5%, bad equipment = 0, etc.

  **Acceptance:**
  - Person handles: 0% or < 5% (some edge cases may slip)
  - Organization handles: 0% or < 5%
  - Equipment commercial/alert: 0
  - Equipment generic-only: reduced
  - All 10 success criteria from spec met

  **Verification:**
  - Audit script output matches spec targets

  **Dependencies:** Task 7, Task 8

  **Files:** None (manual deployment verification)

  **Scope:** S (manual)

  **Agent:** Direct execution.

---

### Checkpoint 3: Complete

- [ ] Validation filter deployed and running
- [ ] Re-audit shows dramatic improvement
- [ ] Rejected entities logged with reasons
- [ ] No regression in existing functionality
- [ ] All tests pass
- [ ] Documentation updated

---

## File Summary

| File | Action | Phase | Scope |
|------|--------|-------|-------|
| `packages/sync/src/entity-extraction/types.ts` | MODIFY | P1 | S |
| `packages/sync/src/mapping/mapping-parser.ts` | MODIFY | P1 | S |
| `packages/sync/src/entity-extraction/entity-validation.ts` | NEW | P1 | M |
| `packages/sync/src/entity-extraction/__tests__/entity-validation.test.ts` | NEW | P1 | M |
| `packages/sync/src/entity-extraction/entity-extraction-service.ts` | MODIFY | P2 | S |
| `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts` | MODIFY | P2 | S |
| `packages/api/src/server.ts` | MODIFY | P3 | S |
| `domain-packs/osint/connectors/twitter-osint.yaml` | MODIFY | P3 | S |
| **Total: 8 files** | **4 new, 4 modified** | | |

## Skills to Load Per Task

| Task | Skills |
|------|--------|
| Task 1 | `javascript-typescript-typescript-advanced-types` |
| Task 2, 3 | `test-driven-development`, `python-development` (for regex patterns, general logic) |
| Task 4 | `javascript-typescript-javascript-testing-patterns`, `test-driven-development` |
| Task 5 | `incremental-implementation` |
| Task 6 | `javascript-typescript-javascript-testing-patterns` |
| Task 7 | `incremental-implementation` |
| Task 8 | None (YAML edit) |
| Task 9 | `ci-cd-and-automation`, manual execution |

## Parallelization

- **Tasks 2 + 3** can be written together (same file)
- **Task 4** can start after Task 3's rule signatures are defined (write tests against interface)
- **Task 8** (YAML edit) is independent of everything — can run any time

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Existing entities already in DB | Low | DB was already cleaned. Clean again before deployment. |
| Validation rejects real entities | High | Run audit BEFORE deploying. Test each rule's positive case. Tests prove Zelensky, NATO, T-90M pass. |
| Per-connector config causes confusion | Low | All rules default ON. Explicitly list in YAML for auditability. |
| Regression in existing tests | High | Run full test suite after each task. Currently 209 tests. |
| Performance overhead | Low | Validation is string checks only. < 0.1ms per entity. |

---

## Review Reconciliation (2026-06-18)

### Critical Fixes Applied to Plan

**Task 3 — Rules updated per review:**
- Person no-handles: uses CamelCase + lowercase_alphanumeric detection, NOT simple lowercase check
- Location no-bare-abbrev: REMOVED entirely (replaced by min-length=2 with no special abbrev handling)
- Equipment no-commercial: word-boundary matching (`\bkeyword\b`)
- Equipment no-alert-systems: stem matching (siren/sirens, alarm/alarms, etc.)
- Equipment no-truncated: word-boundary suffix matching
- Equipment no-generic-only: capitalized exception (accept Patriot, HIMARS, Javelin; reject drones, missiles)
- New cleaning function: stripHashtag (#Ukraine → Ukraine)
- Person min-length: changed from 3 to 2 (consistent with Location)
- Rule composition semantics: AND — ALL enabled rules must pass, first failure short-circuits

**Task 4 — Test count increased:**
- 60+ tests (was 30+)
- 19 rules × min 2 tests each = 38 base
- 10 cleaning function tests
- 8 integration tests (full clean→validate pipeline)
- 4 edge case composition tests (rule ordering, disabled rules, unknown types)

**Task 9 — Added measurement subtask (Task 9a):**
- Run explicit audit SQL to verify each success criterion
- Compare pre-fix baseline numbers against post-fix results
- Audit queries documented in plan appendix

**New: Performance budget added:**
- Validation adds <0.1ms per entity (pure string operations, no I/O)
- 5 tweets/sec × ~8 entities/tweet = ~40 validations/sec → ~4ms total overhead
- No degradation expected at current ingestion rates

**Updated File Count:** 8 files (4 new, 4 modified) — unchanged
**Updated Test Count:** 60+ (was 30+)  
