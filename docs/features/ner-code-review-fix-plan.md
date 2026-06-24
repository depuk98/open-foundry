---
title: NER Pipeline — Code Review Findings Fix Plan
created: 2026-06-20
last_updated: 2026-06-20
type: plan
status: verified
related_components:
  - ner-extraction
  - ner-service
  - sync-engine
related_specs:
  - ner-code-review-findings-spec
  - ner-three-stage-pipeline-spec
  - ner-dedup-fix-spec
---

# Implementation Plan: NER Pipeline Fixes

## Overview

Fix 16 findings from the five-axis code review, including 3 implementation bugs discovered during verification (entity creation failing 100% — `_normalizedName` property mismatch, `person` @link handling, Docker not rebuilt after refactor). The plan is ordered by severity and dependency: fix the dual-create bugs first, then add safety nets (Python tests, error logging), then address remaining nits.

**Verification confirmed:** `entitiesCreated: 0` across all reports. `linksCreated: 0`. `errors` matching entity count. IntelSubject/IntelOrganization/IntelLocation/IntelEquipment creation in uncommitted `createEntity` code causes all entity creation to fail silently.

## Architecture Decisions

1. **Preserve the dual-create pattern (ADR-013).** `createEntity()` creates core Person + IntelSubject extension, returns IntelSubject._id. This is the architecturally correct pattern from the Palantir refactor. The implementation has bugs — the pattern itself is correct. Do NOT revert to single-entity creation.

2. **`_normalizedName` (with underscore) is the correct ODL property name.** Core Person ODL defines `_normalizedName: String`. The objectManager maps this to DB column `normalized_name` by stripping the underscore prefix. The working tree incorrectly changed this to `normalizedName` (no underscore) — revert back.

3. **IntelSubject's `person` field is an ODL `@link`, not a DB column.** `domain-packs/osint/objects/intel-subject.odl:16` defines `person: Person! @link(type: "ProfileForPerson")`. The objectManager may or may not handle inline link creation during `create()`. If not, the fix is to create IntelSubject without `person`, then call `linkManager.createLink('ProfileForPerson', subject._id, person._id)`.

4. **Docker container must be rebuilt with `--no-cache`.** The current container was built from pre-refactor commit `56b9e88`. The staged refactor changes (new ODL files, renamed types) were never deployed. A full rebuild is required. `docker compose down -v` may be needed if schema checksums changed.

5. **Add error logging to catch block.** The silent `catch { result.errors++ }` hides failures. Log errors so operators can detect breakage without DB audits.

6. **No Python tests exist — must add ≥30.** The Python pipeline (997 lines) has zero regression safety net. Run independently of the TypeScript fixes.

## Verification Summary

| # | Finding | Verdict | Evidence |
|---|---------|---------|----------|
| C0 | Dual-create entity creation fails — 100% `entitiesCreated: 0` | **CRITICAL — Confirmed** | Docker logs: 0 created, 0 links. DB: 47 Person orphans, 0 IntelSubject rows. Root cause: 3 bugs — `_normalizedName` property mismatch (working tree removed underscore), `person: person._id` is an ODL `@link` not a column, Docker container never rebuilt after refactor. |
| C1 | `_normalizedName` property name vs DB column | **Reclassified** | `_normalizedName` (with underscore) is CORRECT — matches ODL schema. ObjectManager strips underscore: `_normalizedName` → `normalized_name`. The working tree changed to `normalizedName` — must revert back to `_normalizedName`. |
| C2 | Zero Python tests | **Confirmed** | `python -m pytest` finds 0 tests |
| A1 | ID vs link FK mismatch | **Invalidated** | Link tables use polymorphic `_to_type`/`_to_id` — no FKs |
| A2 | Event→ReportedEvent link type | **Deferred** | 0 links exist — cannot verify; fix with C0 |
| R1-R4 | Readability nits | **Confirmed** | Static code issues, still valid |
| S1 | Raw LLM in logs | **Already fixed** | SHA-256 hashing in place |
| S2-S3 | Security comments | **Confirmed** | Comments missing |
| P1 | O(n²) span dedup | **Already fixed** | maxInput guard in place |
| P2 | Extraction timeout 30s | **Confirmed** | Config still at 30s |
| P3 | LLM sync blocking | **FYI** | Acceptable for conflict-only invocation |

## Task List

### Phase 1: Critical — Fix Entity Creation Regression (3 tasks)

#### Task 1: Fix dual-create `createEntity` bugs + rebuild Docker
- **Description:** The Palantir refactor (ADR-013) introduced a dual-create pattern in `createEntity()` — core Person + IntelSubject extension. This architecture is correct and must be preserved. Three implementation bugs must be fixed:
  1. **Revert `normalizedName` → `_normalizedName`** in all `createEntity()` calls. The working tree has `normalizedName` (no underscore — incorrect). The ODL schema defines `_normalizedName` (with underscore). The objectManager maps `_normalizedName` → DB column `normalized_name` by stripping the underscore prefix. Passing `normalizedName` without underscore may not match the ODL field and could silently fail.
  2. **Fix `person: person._id` in IntelSubject creation.** The IntelSubject ODL defines `person: Person! @link(type: "ProfileForPerson")` — this is a link reference, not a column. Check if `objectManager.create('IntelSubject', { person: person._id })` handles `@link` properties correctly. If not, create the IntelSubject without `person`, then use `linkManager.createLink('ProfileForPerson', subject._id, person._id, {}, ctx)` after creation.
  3. **Rebuild and redeploy.** Docker container was built from pre-refactor commit `56b9e88` (Jun 19). Must rebuild with `--no-cache` to pick up ODL schema changes. May need `docker compose down -v` if schema checksums changed.
- **Acceptance criteria:**
  - `_normalizedName` (with underscore) property in all `createEntity` calls matches ODL schema
  - `person` property on IntelSubject creation is compatible with `objectManager.create()` (either inline link or separate `createLink` call)
  - `entitiesCreated > 0` and `linksCreated > 0` after rebuild
  - `intel_subject` table has rows
  - `mentions_person` link table has non-zero rows
  - All 302 existing TS tests pass
  - TypeScript typecheck clean
- **Verification:**
  - `cd packages/sync && pnpm run typecheck && pnpm run test` — all pass (verify tests match dual-create pattern — if any test expects single-create, update it)
  - `git diff --cached -- packages/sync/src/entity-extraction/__tests__/` — confirm test changes are compatible with code changes
  - `cd deploy && docker compose build --no-cache api-gateway && docker compose up -d`
  - `docker logs deploy-api-gateway-1 2>&1 | grep "NER:" | tail -5`
  - DB audit: `SELECT COUNT(*) FROM intel_subject; SELECT COUNT(*) FROM mentions_person;`
- **Files:** `entity-extraction-service.ts:155-256`, `domain-packs/core/objects/person.odl:20`, `domain-packs/osint/objects/intel-subject.odl:16` (reference only)
- **Scope:** Medium — 1 file, ~40 lines changed + Docker rebuild
- **Depends on:** None

#### Task 2: Add error logging to catch block
- **Description:** The `processReport` catch block (`catch { result.errors++ }`) silently swallows errors. Operators have zero visibility into why entity creation failed. Log the error message and entity type to aid debugging.
- **Acceptance criteria:**
  - Catch block in `processReport` logs `error.message` and `error.stack` via structured logger
  - Error log includes entity type and name (not raw text — hashed for security)
  - Log level: WARN
- **Verification:**
  - Typecheck clean
  - Tests pass
  - If `createEntity` is force-broken in a test, the error message appears in logs
- **Files:** `entity-extraction-service.ts:147-149` (catch block)
- **Scope:** XS — 1 file, ~5 lines
- **Depends on:** None (can run in parallel with Task 1)

#### Task 3: Deploy, clean DB, verify zero failures
- **Description:** Build and deploy the fixed API gateway. Clean all entity and link tables. Wait for fresh ingestion. Verify `entitiesCreated > 0` in Docker logs and data in link tables.
- **Acceptance criteria:**
  - `entitiesCreated > 0` in Docker logs for ≥2 consecutive reports
  - `linksCreated > 0` in Docker logs for ≥2 consecutive reports
  - No error-level logs from NER pipeline for reports that pass validation (rejections via `entitiesRejected` are expected and normal)
  - Link tables have rows: `mentions_person`, `mentions_organization`, `mentions_equipment`, `mentions_location`, `reported_event`
  - 0 exact duplicates in any entity table (`GROUP BY normalized_name HAVING COUNT(*) > 1` returns 0)
- **Verification:**
  - `docker logs deploy-api-gateway-1 | grep "NER:" | tail -5` — check metrics
  - DB audit queries — verify links created, no duplicates
- **Files:** None (deploy only)
- **Scope:** XS — deploy + audit
- **Depends on:** Task 1 (needs code fix deployed) and Task 2 (error logging confirms fix works)

### Checkpoint: Pipeline Working
- [ ] `entitiesCreated > 0` consistently
- [ ] `linksCreated > 0` consistently
- [ ] 0 duplicate entities in DB
- [ ] Link tables have non-zero rows
- [ ] No error-level NER pipeline entries in Docker logs (warnings for rejections are normal)

### Phase 2: Safety Nets — Python Tests + Error Logging (2 tasks)

#### Task 4: Add Python test suite (≥30 tests)
- **Description:** Create `packages/ner-service/tests/` with pytest tests covering all 3 pipeline stages. No existing Python tests. Need coverage for input validation, ensemble merge, LLM response parsing, and LLM output sanitization.
- **Acceptance criteria:**
  - `test_validation.py` — 5+ tests: empty text, oversized text, invalid labels, confidence out of range, max_entities out of range
  - `test_ensemble_merge.py` — 10+ tests: both agree CONFIRMED, both disagree CONFLICT, GLiNER-only SINGLE_SOURCE, Flair-only SINGLE_SOURCE, GLiNER-enriches-MISC, case-only collision ("us" vs "U.S."), confidence threshold filtering, empty input lists
  - `test_llm_reviewer.py` — 10+ tests: valid JSON array, `{"array": [...]}` wrapper, markdown-wrapped, Python single-quote dicts, plain text with embedded dicts, empty response, malformed JSON, `ast.literal_eval` fallback, empty candidates, failed all retries returns original
  - `test_llm_validation.py` — 6+ tests: valid confirm/correct/reject/add, invalid action rejected, invalid type rejected, hallucinated span rejected, nan confidence clamped, non-dict item skipped
  - Total ≥31 tests
  - All pass: `cd packages/ner-service && python -m pytest -v`
- **Files:**
  - `packages/ner-service/tests/__init__.py` (new)
  - `packages/ner-service/tests/test_validation.py` (new)
  - `packages/ner-service/tests/test_ensemble_merge.py` (new)
  - `packages/ner-service/tests/test_llm_reviewer.py` (new)
  - `packages/ner-service/tests/test_llm_validation.py` (new)
  - `packages/ner-service/pyproject.toml` or `requirements-dev.txt` (add pytest)
- **Scope:** Large — 5 new files, ~400 lines of tests
- **Depends on:** Task 3 (can run in parallel)

#### Task 5: Add dedup normalization consistency test
- **Description:** Add a TypeScript test that verifies `_normalizedName` property population in `createEntity` produces a value that `batchResolve` can later find via `normalizeForDedup()`. Prevents future normalization drift between the ODL property name, the objectManager mapping, and the SQL query.
- **Acceptance criteria:**
  - Test: `createEntity` for Person "President Trump" → `batchResolve` for "Trump" → returns same ID (title stripping works across create→query round-trip)
  - Test: `createEntity` for Person "Trump" → `batchResolve` for "President Trump" → returns same ID
  - Test: `createEntity` for Org "General Electric" → `batchResolve` for "General Electric" → returns same ID (no title stripping for Org)
  - All pass
- **Files:**
  - `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts` (add 3 tests)
- **Scope:** XS — 1 file, ~40 lines
- **Depends on:** Task 1

### Checkpoint: Safety Nets
- [ ] ≥31 Python tests pass
- [ ] Dedup normalization consistency tests pass
- [ ] All 302+ existing TS tests still pass
- [ ] Typecheck clean on both Python and TypeScript

### Phase 3: Readability + Security + Performance Nits (3 tasks)

#### Task 6: Fix readability issues (R1-R4)
- **Description:** Address all 4 readability findings from the review spec.
  - R1: Move `flair_stage.py` re-export to import block or document current placement in `constants.py`
  - R2: Replace `PERSON_RULES[0]!.check` with named `checkNoHandles` function
  - R3: `dedup-utils.ts` docstring already says `_normalizedName` — correct per ODL. No change needed.
  - R4: Remove unused `field` import from `ensemble_merge.py:15`
- **Acceptance criteria:**
  - `ensemble_merge.py` imports only `dataclass`
  - `entity-validation.ts` uses named function reference for Org→no-handles rule
  - `dedup-utils.ts` docstring `_normalizedName` is correct per ODL (no change needed)
  - `flair_stage.py` re-export is at top-level imports or documented
  - Typecheck clean, all tests pass
- **Verification:**
  - `cd packages/sync && pnpm run typecheck && pnpm run test`
  - `cd packages/ner-service && python -m pytest` (if Task 4 done)
- **Files:** `ensemble_merge.py`, `entity-validation.ts`, `dedup-utils.ts`, `flair_stage.py`
- **Scope:** S — 4 files, ~15 lines changed
- **Depends on:** Task 1 (can run independently)

#### Task 7: Document security boundaries (S2, S3) + lower timeout (P2) + dedup tradeoff (A3)
- **Description:** Add inline comments documenting security assumptions and performance tradeoffs.
  - S2: Comment on `ner-grpc-client.ts:213` and `server.py:255` noting gRPC is internal Docker network only
  - S3: Comment on `entity-dedup.ts:194` noting `tableNameFor` values are hardcoded constants
  - P2: Lower `EXTRACTION_TIMEOUT` default from 30s → 10s in `config.py:88`
  - A3: Add docblock to `EntityDedupCache` noting in-memory-only tradeoff with ADR reference
- **Acceptance criteria:**
  - Comments present at all 4 locations
  - `EXTRACTION_TIMEOUT` env var at 10s default (override still works)
  - Typecheck clean, all tests pass
- **Files:** `ner-grpc-client.ts`, `server.py`, `entity-dedup.ts`, `config.py`
- **Scope:** XS — 4 files, ~10 lines of comments + 1 config change
- **Depends on:** None

### Phase 4: Follow-up Investigation (1 task)

#### Task 8: Investigate Event link type (A2)
- **Description:** After Task 3 deploys and links are working, verify that `reported_event` links reference the `intel_event` table correctly via `_to_type`/`_to_id`. If `_to_type` is wrong, fix `linkTypeFor('Event')` or the entity type name.
- **Acceptance criteria:**
  - `reported_event` table has rows with `_to_type = 'IntelEvent'` (or correct type discriminator)
  - No link creation errors for Event entities in Docker logs
- **Files:** May need `entity-extraction-service.ts:270`
- **Scope:** XS — investigation only, possible 1-line fix
- **Depends on:** Task 3 (needs working links)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `objectManager.create()` may not support `@link` properties inline (e.g., `person: person._id`) | Medium | Check objectManager behavior. Fallback: create IntelSubject without `person`, then use `linkManager.createLink()` explicitly. |
| `docker compose down -v` may be required due to schema checksum changes from refactor | Medium | Check Docker health after rebuild. If schema mismatch detected, run `down -v` and restart. |
| `_normalizedName` underscore in working tree was changed — need to verify ODL parsing handles it | Low | ODL defines `_normalizedName: String`. ObjectManager already maps it correctly (evidenced by populated DB column). |
| Event `_to_type` mismatch | Low | Deferred to Task 8 after links are working. |

## Open Questions

1. **Does `objectManager.create('IntelSubject', { person: core._id })` auto-create `ProfileForPerson` links?** The IntelSubject ODL defines `person` as `@link(type: "ProfileForPerson")`. Need to check if the objectManager handles `@link` properties during object creation. If not, the fallback is explicit `linkManager.createLink()`.

2. **Is `docker compose down -v` required for schema checksum migration?** The refactor session note says "Schema checksums changed. Migration plan auto-approved (version 1→2)." A clean restart with `down -v` may be needed.

3. **Is `pytest` available in the ner-service Docker image?** Need to check `Dockerfile` or `pyproject.toml` for Python dev dependencies.

4. **Is 10s appropriate for long-form documents?** `EXTRACTION_TIMEOUT` default lowered from 30s→10s. Articles >10K chars may need more time.

## Commands Reference

```
Python tests:    cd packages/ner-service && python -m pytest -v
TS tests:        cd packages/sync && pnpm run test
TS typecheck:    cd packages/sync && pnpm run typecheck
Build API:       cd deploy && docker compose build api-gateway
Deploy API:      cd deploy && docker compose up -d api-gateway
Full rebuild:    cd deploy && docker compose build ner-service api-gateway && docker compose up -d
DB clean:        PGPASSWORD=changeme psql -h localhost -p 5433 -U openfoundry -d openfoundry
DB audit dups:   SELECT normalized_name, COUNT(*) FROM person GROUP BY normalized_name HAVING COUNT(*) > 1;
Audit links:     SELECT COUNT(*) FROM mentions_person;
Docker logs:     docker logs deploy-api-gateway-1 2>&1 | grep "NER:" | tail -5
```
