---
title: NER Pipeline — Code Review Findings & Remediation Spec
created: 2026-06-20
last_updated: 2026-06-20
type: spec
status: reconciled — dual-create pattern correct (ADR-013), C0 is implementation bugs not removal
related_components:
  - ner-extraction
  - ner-service
  - sync-engine
  - api-gateway
related_features:
  - osint-domain-pack
  - ner-three-stage-pipeline-spec
  - ner-dedup-fix-spec
  - ner-data-quality-fix-spec
---

# Spec: NER Pipeline — Code Review Findings & Remediation

## 1. Objective

Comprehensive remediation plan for 15 findings discovered during a five-axis code review of the three-stage NER pipeline (Python `ner-service` 997 lines + TypeScript `entity-extraction` 991 lines). The review covered correctness, readability, architecture, security, and performance.

**Who this is for:** Engineers maintaining the NER pipeline. The fixes eliminate the root causes of persistent entity duplication, add Python test safety nets, and resolve architectural ambiguities.

**Success looks like:**
- 0 exact-duplicate entities in DB after container restart (dedup survives cold start)
- Python NER service has automated test coverage for all 3 stages
- Dual-create pattern (core + Intel extension) works: `entitiesCreated > 0`, `linksCreated > 0`
- Remaining 11 findings are addressed or explicitly deferred

## 2. Tech Stack

- Python 3.12+ — `packages/ner-service/` (gRPC server, GLiNER, Flair, Ollama)
- TypeScript — `packages/sync/src/entity-extraction/` (pipeline orchestrator, dedup, validation)
- Docker Compose — `deploy/docker-compose.yaml`
- pytest — for new Python tests
- vitest — for TypeScript tests
- PostgreSQL — `normalized_name` column on `person`, `organization`, `location`, `equipment`

## 3. Commands

```
Python tests:   cd packages/ner-service && python -m pytest -v
TS tests:       cd packages/sync && pnpm run test
TS typecheck:   cd packages/sync && pnpm run typecheck
Build API:      cd deploy && docker compose build api-gateway
Deploy API:     cd deploy && docker compose up -d api-gateway
DB audit:       docker exec -it deploy-db-1 psql -U openfoundry -d openfoundry
Full rebuild:   cd deploy && docker compose build ner-service api-gateway && docker compose up -d
```

## 4. Project Structure

```
packages/ner-service/                    # Python gRPC NER sidecar
├── server.py                            # gRPC server + 3-stage orchestrator
├── ensemble_merge.py                    # Stage 2: GLiNER + Flair merge
├── gliner_stage.py                      # Stage 1a: GLiNER loader + extractor
├── flair_stage.py                       # Stage 1b: Flair loader + extractor
├── llm_reviewer.py                      # Stage 3: Ollama phi4-mini review
├── llm_validation.py                    # LLM output sanitization
├── validation.py                        # gRPC input validation
├── config.py                            # Environment-based configuration
├── constants.py                         # Shared FLAIR_TAG_MAP + LLM action strings
├── text_utils.py                        # Context extraction helper
├── logging_config.py                    # Structured logging setup
├── proto/ner.proto                      # gRPC contract
└── tests/                               # NEW — pytest test suite

packages/sync/src/entity-extraction/     # TypeScript pipeline
├── entity-extraction-service.ts         # Orchestrator: extract → clean → dedup → store
├── entity-dedup.ts                      # In-memory LRU cache + batch DB queries
├── entity-validation.ts                 # 19 validation rules, 6 cleaners
├── ner-grpc-client.ts                   # gRPC client with circuit breaker
├── grpc-extractor.ts                    # EntityExtractor impl (gRPC primary)
├── composite-extractor.ts               # EntityExtractor impl (gRPC + compromise fallback)
├── dedup-utils.ts                       # Shared normalizeForDedup()
├── types.ts                             # ExtractedEntity, ValidationConfig, etc.
└── __tests__/                           # vitest test suites (16 files, 302 tests)
```

## 5. Findings Summary

### 5.1 Correctness — 3 findings

#### C0 [Critical]: Dual-create entity creation fails — 100% of `createEntity` and links broken

- **File:** `entity-extraction-service.ts:155-256`, `domain-packs/osint/objects/intel-subject.odl`, `domain-packs/core/objects/person.odl`
- **Architecture context:** The Palantir refactor (ADR-013) introduced a dual-create pattern: `createEntity()` creates a **core** Person with identity attributes, then an **IntelSubject** extension with intel-specific attributes. Returns IntelSubject._id. This is the correct architecture — do NOT revert it. The problem is implementation bugs, not architecture.
- **Root cause — 3 bugs:**
  1. **`person: person._id` passed to `objectManager.create('IntelSubject', ...)` may not be handled correctly.** IntelSubject ODL defines `person` as `@link(type: "ProfileForPerson")` — a link, not a column. The objectManager must support inline link creation during object creation. If it doesn't, the call silently fails. 
  2. **Docker container not rebuilt after refactor.** The container was built from commit `56b9e88` (Jun 19) — the pre-refactor codebase. The refactor's staged changes were never deployed. The pipeline runs the old code that doesn't even attempt dual-create.
  3. **`_normalizedName` ODL field maps to DB column `normalized_name` (no underscore).** The objectManager strips the underscore prefix during camelCase→snake_case mapping. This is working correctly for existing rows (all 47 have `normalized_name` populated). The working-tree code changed `_normalizedName` → `normalizedName` (removing underscore) which may break the mapping.
- **Impact:** Every report: `entitiesCreated: 0, linksCreated: 0, errors: N`. 47 orphaned Person rows (canonical created, Intel extension failed). All 5 link tables empty. The pipeline stores nothing new — only dedup hits on pre-existing entities work.
- **Fix:**
  1. **Investigate `objectManager.create('IntelSubject', { person: core._id })` behavior.** Check if the objectManager auto-creates `ProfileForPerson` links from the `@link` directive in ODL. If not, use `linkManager.createLink('ProfileForPerson', subject._id, person._id, {}, ctx)` after IntelSubject creation, without passing `person` as a property.
  2. **Keep `_normalizedName` property (with underscore).** The ODL schema defines it as `_normalizedName`. The objectManager maps it correctly to DB column `normalized_name`. Do not change it to `normalizedName`.
  3. **Build and deploy Docker after all fixes.** `docker compose build --no-cache api-gateway && docker compose up -d`
  4. **`docker compose down -v` may be required** because schema checksums changed (refactor session note).
- **Acceptance criteria:**
  - `entitiesCreated > 0` and `linksCreated > 0` in Docker logs
  - `intel_subject` table has rows with `_tenant_id`, `_id`, `watchlist_status`, `is_person_of_interest` populated
  - `mentions_person` (or `mentions_subject`) link table has non-zero rows
  - Each Person in `person` table has a corresponding IntelSubject row

#### C1 [Verification]: `_normalizedName` property name must match ODL schema, not DB column

- **File:** `entity-extraction-service.ts:174, 190, 204, 219, 233`, `entity-dedup.ts:118, 179`, `domain-packs/core/objects/person.odl:20`
- **Finding after reconciliation:** The ODL schema defines `_normalizedName: String` (WITH underscore prefix) on core `Person`. The objectManager maps ODL camelCase fields to DB snake_case columns. `_normalizedName` → `normalized_name` (objectManager strips the underscore prefix during mapping). The DB column IS `normalized_name` (no underscore). This is consistent.
- **The SQL query in `entity-dedup.ts` uses `"normalized_name"` (no underscore in double-quoted SQL) — this is CORRECT.** The query matches the actual DB column name.
- **The TypeScript property must be `_normalizedName` (with underscore) to match the ODL**, so the objectManager recognizes it as the ODL field and maps it to the `normalized_name` DB column. Passing `normalizedName` (no underscore) may not match any ODL field and could be silently ignored.
- **Current state:** The working tree has `normalizedName` (no underscore — this session's earlier change). The staged refactor code has `_normalizedName` (with underscore — correct). The committed code also has `_normalizedName` (with underscore — also correct for ODL mapping).
- **Fix:** Revert the working tree from `normalizedName` → `_normalizedName` in `createEntity()` calls. The underscore is required for ODL schema matching.

#### C2 [Critical]: Zero Python test coverage — 997 lines across 9 modules

- **File:** `packages/ner-service/` — all 9 modules
- **Root cause:** Tests were never written for the Python sidecar. All verification is manual via `docker compose up` → DB audit.
- **Impact:** Any regression in the merge algorithm (`ensemble_merge.py`), LLM response parsing (`llm_reviewer.py:_parse_llm_response`), LLM output validation (`llm_validation.py`), or gRPC input validation (`validation.py`) goes undetected until it shows up as bad data in the knowledge graph. The 5 separate fallback paths in `_parse_llm_response` have zero regression protection.
- **Fix:**
  1. Create `packages/ner-service/tests/` directory with `__init__.py`
  2. Add `pytest` as a dev dependency in `packages/ner-service/pyproject.toml` (or `requirements-dev.txt`)
  3. Write tests for:
     - `validation.py` — `test_validate_extract_request()`: empty text, oversized text, invalid labels, confidence out of range, max_entities out of range. **4–6 tests.**
     - `ensemble_merge.py` — `test_merge()`: both models agree on span+type (CONFIRMED), both disagree (CONFLICT), GLiNER-only (SINGLE_SOURCE), Flair-only (SINGLE_SOURCE), GLiNER enriches MISC (GLINER_ENRICHED), case-only collision (e.g., "us" MISC vs "U.S." Location), confidence threshold filtering. **8–12 tests.**
     - `llm_reviewer.py` — `test_parse_llm_response()`: valid JSON array, `{"array": [...]}` wrapper, markdown-wrapped JSON, Python-style single-quote dicts, plain text with embedded dicts, empty response, malformed JSON, `ast.literal_eval` fallback. **8–10 tests.**
     - `llm_validation.py` — `test_validate_llm_output()`: valid confirm/correct/reject/add, invalid action rejected, invalid type rejected, hallucinated span rejected (span not in source_text), nan confidence clamped. **6–8 tests.**
     - `server.py` — `test_extract_entities_invalid_request()`: INVALID_ARGUMENT on empty text. Mock GLiNER + Flair availability. **2–3 tests.**
  4. Add `pytest` command to CI or docker build
- **Acceptance criteria:**
  - `cd packages/ner-service && python -m pytest -v` passes ≥30 tests
  - All 3 pipeline stages (gRPC input, merge, LLM parsing) have coverage
  - Breaking the merge or LLM parser produces a test failure

### 5.2 Readability — 4 findings

#### R1 [Nit]: `constants.py` is 23 lines — merge into `config.py` or keep with explicit rationale

- **File:** `packages/ner-service/constants.py`
- **Observation:** 4 LLM action strings + a 6-line `FLAIR_TAG_MAP` in a separate file. The `flair_stage.py:32` import `from constants import FLAIR_TAG_MAP as FLAIR_TYPE_MAP  # noqa: F401` is awkward — it's a mid-file re-export placed after module state.
- **Fix (option):** Keep `constants.py` but add a docstring explaining why it's separate (`flair_stage` can't import from `ensemble_merge` due to circular imports). Move the `flair_stage.py` re-export to the top-level import block.
- **Acceptance criteria:** `flair_stage.py` re-export is in the import block, not mid-file. Or document that the current placement is intentional.

#### R2 [Nit]: `PERSON_RULES[0]!.check` — Orgs reuse Person's no-handles rule by index

- **File:** `entity-validation.ts:115`
- **Risk:** If Person rules are reordered (e.g., `no-handles` moves to index 2), the Org validation silently uses the wrong rule. The `!` assertion masks `undefined` if the array is empty.
- **Fix:** Extract the `no-handles` check as a named function (`checkNoHandles`) referenced by both `PERSON_RULES` and `ORG_RULES`.
- **Acceptance criteria:** `PERSON_RULES[0]!.check` replaced with named function reference. Reordering Person rules does not affect Org validation.

#### R3 [Nit — Already correct]: `dedup-utils.ts` docstring references `_normalizedName` (underscore) — this is correct

- **File:** `dedup-utils.ts:5`
- **Reconciled:** The docstring says `(populate _normalizedName on entity creation)` which matches the ODL schema property name (`_normalizedName: String` on `core/objects/person.odl:20`). The underscore is correct — no change needed. The original R3 finding (to remove underscore) was written before the ODL schema reconciliation confirmed `_normalizedName` is the correct property name.
- **Fix:** No change needed.

#### R4 [Nit]: Unused `field` import in `ensemble_merge.py`

- **File:** `ensemble_merge.py:15` — `from dataclasses import dataclass, field`
- **Fix:** Remove `, field` from the import.
- **Acceptance criteria:** No unused imports in the module.

### 5.3 Architecture — 3 findings

#### A1 [Invalidated]: `createEntity` for Person returns `IntelSubject._id` — verify link target consistency

- **File:** `entity-extraction-service.ts:169-183`
- **Verification result:** Link tables (`mentions_person`, etc.) use a polymorphic `_to_type`/`_to_id` pattern with **zero foreign key constraints**. The `_to_type` discriminator identifies which table `_to_id` references. There is no FK that could be broken by returning an IntelSubject ID vs a Person ID. The actual problem is the IntelSubject creation itself fails (see C0), not the ID mismatch. This finding is invalidated.
- **No action needed.** C0 fix resolves IntelSubject creation. The link system uses polymorphic `_to_type`/`_to_id` — IntelSubject._id as return value is correct.

#### A2 [Deferred]: Event → `ReportedEvent` link type vs `IntelEvent` storage table

- **File:** `entity-extraction-service.ts:242-251, 270`
- **Verification result:** `reported_event` table currently has 0 rows (no links exist). Cannot verify whether the `_to_type` discriminator correctly references `IntelEvent`. Deferred until C0 fix restores link creation. Investigation task in fix plan (Task 8).

#### A3 [FYI]: In-memory LRU dedup has no cross-container persistence — deliberate tradeoff

- **File:** `entity-dedup.ts:25, 148-164`
- **Context:** The `EntityDedupCache` is a `Map<string, CacheEntry>` — purely in-memory. On container restart, the entire dedup state is lost. The `batchResolve` DB fallback (lines 77-146) mitigates this by batch-querying `normalized_name` values, but it depends on exact match only (no fuzzy/near-duplicate).
- **Status:** This is a deliberate tradeoff (documented in ADR-012). The pipeline is CPU-only, ~6.5GB RAM. Adding Redis for persistent dedup would add operational complexity. The `batchResolve` optimization (N queries → ≤4) makes cold starts fast enough.
- **Fix:** Add an explicit comment in `entity-dedup.ts` acknowledging the tradeoff and linking to the ADR.
- **Acceptance criteria:** Dedup class docblock mentions the in-memory-only constraint with ADR reference.

### 5.4 Security — 3 findings

#### S1 [Already Fixed]: Raw LLM response in logs → now uses SHA-256 hash

- **File:** `llm_reviewer.py:122-125`
- **Status:** ✅ Fixed. Previously logged `raw[:200]` (raw LLM output). Now logs `hashlib.sha256(raw.encode()).hexdigest()[:16]` — only the hash. Same fix applied in `llm_validation.py:86` for source text logging.
- **No action needed.**

#### S2 [Nit]: Plaintext gRPC (`createInsecure`) — document the network assumption

- **File:** `ner-grpc-client.ts:213` and `server.py:255`
- **Observation:** gRPC client connects with `grpc.credentials.createInsecure()`. Server binds with `server.add_insecure_port()`. No TLS/mTLS.
- **Risk:** Low — NER service and API gateway run on the same Docker network. The service is never exposed outside Docker.
- **Fix:** Add a comment in `ner-grpc-client.ts` constructor and `server.py:255` documenting the assumption: "This service is only accessible within the Docker network. TLS is not required for internal gRPC."
- **Acceptance criteria:** Both client and server have comments documenting the network security boundary.

#### S3 [Low]: SQL table name interpolation could become injectable

- **File:** `entity-dedup.ts:118-121, 179-181` — `${tableName}` interpolation
- **Observation:** Table names are hardcoded in `tableNameFor()` (switch-case for all 9 entity types → static values like `'person'`, `'organization'`). No user input reaches the table name. Safe today.
- **Risk:** Low. Would only become a risk if a future developer adds a `default: return type.toLowerCase()` path that accepts arbitrary user input. Currently the default does exist (line 205) but only for unknown types that would never reach this code path.
- **Fix:** Add a comment on `tableNameFor` noting: "All table names are hardcoded constants — no user input is interpolated into SQL identifiers."
- **Acceptance criteria:** Comment present on `tableNameFor()`. Or: whitelist check before interpolation.

### 5.5 Performance — 3 findings

#### P1 [Already Fixed]: O(n²) span dedup bounded by maxInput guard

- **File:** `entity-extraction-service.ts:33-42`
- **Status:** ✅ Fixed. `deduplicateOverlappingSpans` now has `maxInput = 200` guard + caller passes `maxEntities * 2 = 40`. Maximum 1,600 comparisons. Comment documents the O(n²) bound.
- **No action needed.**

#### P2 [Consider]: Stage 1 extraction timeout is 30s — could be lower for tweets

- **File:** `config.py:88` — `EXTRACTION_TIMEOUT = _env_float("EXTRACTION_TIMEOUT", 30.0)`
- **Observation:** GLiNER + Flair process tweet-length text (≤280 chars) in <2s. A 30s timeout means a hung model blocks the gRPC handler for up to 30s before partial results are returned.
- **Fix:** Lower default to 10s. Keep it configurable via env var for longer document use cases.
- **Acceptance criteria:** `EXTRACTION_TIMEOUT` default lowered to 10s. Env-var override still works.

#### P3 [FYI]: LLM review is synchronous per-request — acceptable for conflict-only invocation

- **File:** `server.py:152` — `llm_reviewer.review()` blocks gRPC handler.
- **Observation:** LLM review only invoked for ~20-30% of tweets (conflicts detected). With `LLM_TIMEOUT_SECONDS=3`, worst case ~6s (1 retry). The gRPC client timeout is 5s — the LLM timeout wins.
- **Status:** Acceptable tradeoff. Not an immediate concern. If throughput increases (>100 requests/s), consider a `Future`/callback pattern or async gRPC handler.
- **No action needed.**

## 6. Tasks

> **Note:** The authoritative task list is in `docs/features/ner-code-review-fix-plan.md`. This section provides a summary. See the fix plan for detailed acceptance criteria, verification steps, and dependencies.

### Phase 1: Critical — Fix Entity Creation Regression (3 tasks)

- [ ] **Task 1:** Fix dual-create bugs: revert `normalizedName` → `_normalizedName` (underscore matches ODL), fix `person: person._id` @link handling in IntelSubject creation, rebuild Docker. (C0)
- [ ] **Task 2:** Add structured error logging to `processReport` catch block. (C0)
- [ ] **Task 3:** Build, deploy, clean DB, verify `entitiesCreated > 0` and `linksCreated > 0`. (C0)

### Phase 2: Safety Nets (2 tasks)

- [ ] **Task 4:** Add ≥31 Python pytest tests covering validation, merge, LLM parsing, LLM output validation. (C2)
- [ ] **Task 5:** Add dedup normalization consistency test — prove `createEntity` → `batchResolve` round-trip. (C1 — preventative)

### Phase 3: Readability + Security + Performance (2 tasks)

- [ ] **Task 6:** Fix readability issues: unused `field` import, `PERSON_RULES[0]!.check` → named function, docstring typo, re-export placement. (R1-R4)
- [ ] **Task 7:** Document security boundaries (gRPC insecure comment, SQL interpolation safety), lower `EXTRACTION_TIMEOUT` 30s→10s, add dedup in-memory-only docblock. (S2, S3, P2, A3)

### Phase 4: Follow-up Investigation (1 task)

- [ ] **Task 8:** After links are working, verify `reported_event._to_type` references `IntelEvent` correctly. (A2)

## 7. Boundaries

### Always Do
- Run typecheck + all tests before marking a task complete
- Test cold-start (empty LRU) scenario for dedup changes
- Parameterize DB queries (no string concatenation)
- Log only hashed content, not raw LLM or source text

### Ask First
- Database schema changes (new columns, FK alterations)
- Adding new Python dependencies (including pytest — check if uv/pip already has it)
- Changing `normalizeForDedup` logic (breaks existing DB `normalized_name` consistency)

### Never Do
- Skip test verification for dedup fixes — the bug has already recurred
- Change `tableNameFor` switch cases without updating `linkTypeFor` and `createEntity`
- Remove the circuit breaker from `ner-grpc-client.ts`

## 8. Success Criteria

| # | Criterion | How to verify |
|---|-----------|---------------|
| 1 | Python tests pass | `cd packages/ner-service && python -m pytest -v` — ≥30 passing |
| 2 | TS tests pass | `cd packages/sync && pnpm run test` — all 302+ pass |
| 3 | 0 duplicate entities after cold start | Clean DB → ingest → restart container → re-ingest → `SELECT normalized_name, COUNT(*) FROM person GROUP BY normalized_name HAVING COUNT(*) > 1` returns 0 rows |
| 4 | Link creation works after C0 fix | `SELECT COUNT(*) FROM mentions_person` returns >0 rows. `_to_type` discriminator is correct for all link tables |
| 5 | All nit fixes applied | Unused imports removed, docstrings correct, named function replaces index reference |
| 6 | Security comments present | Insecure gRPC rationale, SQL interpolation safety comments |

## 9. Open Questions

1. **C0:** What is the intent of the uncommitted IntelSubject code? The CDM schema has `intel_subject`/`intel_organization`/`intel_equipment`/`intel_location` tables. Someone added them to `createEntity` for a reason. Reverting breaks that feature. Need to understand the intent, then either fix the schema to match the code, or fix the code to match the schema.
2. **C0:** Why does `linkManager.createLink` fail even for dedup-hit entities? Task 2 (error logging) will reveal this. Possible causes: wrong `_to_type` discriminator, missing required link properties, or the linkManager expects different parameter types.
3. **C2:** Is `pytest` already available in the ner-service Docker image? Or does it need to be added to `Dockerfile` / `pyproject.toml`?
4. **P2:** Is 10s appropriate for long-form documents (articles, reports > 10K chars)? Or should the timeout scale with text length?
