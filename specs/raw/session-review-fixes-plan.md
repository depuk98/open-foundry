# Implementation Plan: Session Review Fixes (2026-06-19)

## Overview

Implement 16 fixes across TypeScript (twitter-connector, entity-dedup, server.ts, entity-extraction-service) and Python (ner-service) identified in two independent code reviews. Four parallel workstreams: database layer, Twitter connector, Python NER, and server.ts decomposition.

**Verification gate:** `pnpm --filter @openfoundry/sync test` (302+ tests) + `python -m pytest packages/ner-service/tests/ -v` must pass after every phase. Cross-model: offer before starting Phase 3 (highest blast radius).

---

## Architecture Decisions

- **`_normalized_name` column** over `LIKE` — exact `=` B-tree index vs slow LIKE scan, no false positives
- **Dedup key unchanged** — `{type}:{normalized_name}`. The column just makes the DB speak the same language as the cache
- **30s thread timeout** for Stage 1 models — catches hangs without false timeouts under CPU load
- **3 retries, 1s exponential backoff** for gRPC fallback — confirmed balance
- **800-900 line target** for `server.ts` — extract NER bootstrap, connector wiring, and middleware. Full route extraction is future work.

---

## Dependency Graph

```
Phase 1 (Foundation) — all parallel
  A._normalized_name schema ──┐
  B. Python constants.py    ──┼──┐
  C. Bearer token env-var      │  │
  G. incrementalExtract pagin  │  │
                               ▼  ▼
Phase 2 (Core fixes) — per-domain parallel
  DB layer:     D (normalize write) → E (batch lookup)
                F (null coords) — parallel, no dep on D/E
  
  Twitter:      H (search cursor) ─┐
                I (authorScreenName)├── J (extractTweets refactor)
                (depends on G)      │
                                    │
  Python NER:   K (case collisions) │
                L (constants refac) │
                M (thread timeout)  │
                N (log hygiene)     │
                                    │
                                    ▼
Phase 3 (Integration + server.ts)
  O (NER bootstrap) → P (connector bootstrap) → Q (middleware setup) → R (gRPC retry)
  S (O(n²) comment) — any time after E
  T (backfill) — after D

Checkpoint: 16/16 addressed, tests pass, server.ts 800-900 lines
```

---

## Task List

### Phase 1: Foundation (4 tasks, all parallel)

---

#### Task A: Add `_normalized_name` columns and indexes to entity tables

**Description:** Create a DDL migration that adds `_normalized_name TEXT` column + partial index to `person`, `organization`, `location`, `equipment`, `event` tables. Also declare the `_normalized_name` field in each entity type's ODL schema (`.odl` or `.ddl.sql`) so `ObjectManager.create()` accepts and persists it. The column stores the same output as `normalizeForDedup()`: title-stripped and lowercased for Person, lowercased for everything else. Use a partial index on `("_tenant_id", "_normalized_name") WHERE "_deleted_at" IS NULL`.

**Important:** `normalizeForDedup()` is currently a private method on `EntityDedupCache`. Before implementing Tasks D/E/F, this function must be extracted to a public exported utility (`packages/sync/src/entity-extraction/dedup-utils.ts`) so both `EntityDedupCache` and `EntityExtractionService.createEntity()` can import it.

**Acceptance criteria:**
- [ ] 5 new columns exist across entity tables
- [ ] 5 partial B-tree indexes created
- [ ] `_normalized_name` defaults to `NULL` (rows created before migration)
- [ ] Migration is idempotent (`IF NOT EXISTS` or equivalent guards)

**Verification:**
- [ ] `docker compose down -v && docker compose up -d postgresql` — clean DB
- [ ] Run migration — no errors
- [ ] `SELECT column_name FROM information_schema.columns WHERE table_name = 'person' AND column_name = '_normalized_name'` → 1 row

**Dependencies:** None

**Files likely touched:**
- `domain-packs/osint/000-schema.ddl.sql` (or equivalent migration file)
- Each entity type's `.odl` or `.ddl.sql` (5 files — add `_normalized_name` field declaration)
- `deploy/init-services.sh` (if migration triggers from here)
- `packages/sync/src/entity-extraction/dedup-utils.ts` (NEW — export `normalizeForDedup`)

**Estimated scope:** S (1-2 files)

---

#### Task B: Create Python `constants.py` with shared maps and action strings

**Description:** Create `packages/ner-service/constants.py` containing the shared constants currently duplicated across modules:
- `FLAIR_TAG_MAP` — extracted from `flair_stage.py:30-35` and `ensemble_merge.py:25-31`
- `LLM_ACTION_CONFIRM`, `LLM_ACTION_CORRECT`, `LLM_ACTION_ADD`, `LLM_ACTION_REJECT` — extracted from `llm_reviewer.py:251,260,269` and `server.py:47-52`
- `TYPE_RESOLUTION` — consider extracting from `ensemble_merge.py:36-51` if used elsewhere
- `EXTRACTION_TIMEOUT` constant for #14

**Acceptance criteria:**
- [ ] `constants.py` exists with all 4+ constants/maps
- [ ] `flair_stage.py` imports `FLAIR_TAG_MAP` from `constants` instead of defining its own
- [ ] `ensemble_merge.py` imports `FLAIR_TAG_MAP` from `constants` instead of defining its own
- [ ] All LLM action string comparisons use the constants (not literals)
- [ ] `llm_reviewer.py:300`: `status == 4` replaced with `status == ner_pb2.ENTITY_STATUS_CONFLICT` (protobuf constant)

**Verification:**
- [ ] `python -m pytest packages/ner-service/tests/ -v` — all tests pass (no behavior change)
- [ ] `rg '"confirm"|"correct"|"add"|"reject"' packages/ner-service/` — zero matches in `server.py`, zero in non-definition locations of `llm_reviewer.py`
- [ ] `rg 'status\s*==\s*4' packages/ner-service/llm_reviewer.py` — zero matches

**Dependencies:** None

**Files likely touched:**
- `packages/ner-service/constants.py` (NEW)
- `packages/ner-service/flair_stage.py`
- `packages/ner-service/ensemble_merge.py`
- `packages/ner-service/llm_reviewer.py`
- `packages/ner-service/server.py`
- `packages/ner-service/config.py`

**Estimated scope:** M (3-5 files)

---

#### Task C: Make Twitter Bearer token env-overridable

**Description:** In `twitter-connector.ts:329`, replace the hardcoded Bearer token with `process.env["TWITTER_BEARER_TOKEN"] ?? <hardcoded-fallback>`. Keep the existing public anonymous guest token as fallback.

**Acceptance criteria:**
- [ ] `TWITTER_BEARER_TOKEN` env var is read, with hardcoded fallback
- [ ] Hardcoded token survives as fallback only (not removed)
- [ ] Behavior unchanged when env var is unset

**Verification:**
- [ ] `pnpm --filter @openfoundry/sync test` — all 302 tests pass
- [ ] Manual: `TWITTER_BEARER_TOKEN=test pnpm run dev` — uses test token

**Dependencies:** None

**Files likely touched:**
- `packages/sync/src/connectors/twitter-connector.ts` (line 329)

**Estimated scope:** XS (1 line change)

---

#### Task G: Add pagination loop to `incrementalExtract`

**Description:** `incrementalExtract` currently calls `fetchUserTweets(userId, undefined)` once — yielding only the first 40 tweets. Add a pagination loop: fetch page → yield tweets newer than `sinceTweetId` → update cursor from last tweet → repeat until tweets are older than checkpoint or page limit hit (5 pages, 200 tweets max).

**Acceptance criteria:**
- [ ] `incrementalExtract` paginates through pages until all tweets since checkpoint are retrieved
- [ ] Cursor is updated from the last tweet in each page (oldest tweet, since timeline returns newest-first)
- [ ] `sinceTweetId` comparison correctly stops the loop when tweets are older than checkpoint
- [ ] **Boundary page handling**: When a page straddles `sinceTweetId` (some tweets newer, some older), only the newer tweets are yielded, then the loop exits — older tweets on that page are NOT yielded
- [ ] Hard cap at 5 pages (200 tweets) to prevent infinite loops
- [ ] Uses `fetchUserTweets` response's `next_cursor` metadata for pagination, not tweet IDs (verify against actual API response format)

**Verification:**
- [ ] Unit test: mock `graphqlRequest` to return 2 pages of tweets, verify all 80 yielded
- [ ] Unit test: tweets older than `sinceTweetId` cause loop exit
- [ ] `pnpm --filter @openfoundry/sync test` — all tests pass

**Dependencies:** None (parallel with A, B, C)

**Files likely touched:**
- `packages/sync/src/connectors/twitter-connector.ts` (lines 226-239)
- `packages/sync/src/connectors/__tests__/twitter-connector.test.ts` (NEW)

**Estimated scope:** M (2-3 files)

---

### Checkpoint: Phase 1 complete
- [ ] `pnpm --filter @openfoundry/sync test` — 302+ tests pass
- [ ] `python -m pytest packages/ner-service/tests/ -v` — tests pass
- [ ] Migration file exists, Python constants module exists
- [ ] Bearer token is env-overridable

---

### Phase 2: Core Fixes (8 tasks, 4 per domain, parallel within domains)

---

#### Task D: Populate `_normalized_name` on entity creation + update dedup query

**Description:** In `entity-extraction-service.ts:createEntity()`, add `_normalizedName` (computed by importing the public `normalizeForDedup` from `dedup-utils.ts`) to every entity creation call (Person, Organization, Location, Equipment, Event). In `entity-dedup.ts:queryByName()`, change the SQL query from `LOWER("full_name") = LOWER($2)` to `"_normalized_name" = $2`. Add a `batchResolve()` method (see Task E). Refactor `EntityDedupCache` to import `normalizeForDedup` from the new `dedup-utils.ts` utility.

**Acceptance criteria:**
- [ ] All `createEntity()` paths populate `_normalizedName` using `normalizeForDedup()`
- [ ] `queryByName()` queries `WHERE "_normalized_name" = $2` (exact match, no LOWER)
- [ ] SQL uses the `_normalized_name` partial index
- [ ] Title-stripped Person names in DB are found across restarts

**Verification:**
- [ ] Unit test: create "President Trump" → lookup "trump" → must find existing entity
- [ ] Unit test: create "Trump" → lookup "President Trump" → must find existing entity
- [ ] `pnpm --filter @openfoundry/sync test` — all tests pass

**Dependencies:** Task A (schema migration must run first)

**Files likely touched:**
- `packages/sync/src/entity-extraction/entity-dedup.ts` (lines 100-120)
- `packages/sync/src/entity-extraction/entity-extraction-service.ts` (lines 143-219)
- `packages/sync/src/entity-extraction/__tests__/entity-dedup.test.ts`
- `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts`

**Estimated scope:** M (3-4 files)

---

#### Task E: Batch dedup DB lookups (`batchResolve`)

**Description:** Add a `batchResolve()` method to `EntityDedupCache` that groups unresolved entity names by table, sends one `WHERE "_normalized_name" = ANY($2)` query per table, and populates the cache. Update `EntityExtractionService.processReport()` to batch all uncached entities instead of calling `resolve()` in a per-entity loop.

**Acceptance criteria:**
- [ ] `batchResolve()` sends at most 4 queries for 20 entities (person, organization, location, equipment)
- [ ] `ANY($2)` correctly handles the array parameter for `_normalized_name` columns
- [ ] Cache populated for all resolved entities in one pass
- [ ] Fallback: entities not found in batch are created individually (unchanged behavior)

**Verification:**
- [ ] Unit test: 20 entities of mixed types → exactly 4 DB queries
- [ ] Unit test: entities already in LRU cache are skipped (no DB query for cached)
- [ ] Unit test: partial batch results — 3 found in DB, 17 created → correct counts
- [ ] `pnpm --filter @openfoundry/sync test` — all tests pass

**Dependencies:** Tasks A (schema), D (normalized_name in createEntity + query)

**Files likely touched:**
- `packages/sync/src/entity-extraction/entity-dedup.ts`
- `packages/sync/src/entity-extraction/entity-extraction-service.ts`
- `packages/sync/src/entity-extraction/__tests__/entity-dedup.test.ts`

**Estimated scope:** M (3 files)

---

#### Task F: Store `null` coordinates for unknown locations

**Description:** In `entity-extraction-service.ts:createEntity()` for Location/ConflictZone, change `location: { latitude: 0, longitude: 0 }` to `location: null`. NER-extracted locations like "Bakhmut" should not have fake coordinates.

**Acceptance criteria:**
- [ ] Location entities created via NER have `location: null`
- [ ] ConflictZone entities created via NER have `location: null`
- [ ] Event entities created via NER have `location: null`
- [ ] `country: 'UNKNOWN'` is acceptable (kept as-is — it's a semantic default, not a misleading geocoordinate)

**Verification:**
- [ ] Unit test: NER creates Location "Bakhmut" → `location` is `null`
- [ ] `pnpm --filter @openfoundry/sync test` — all tests pass, including existing Location tests

**Dependencies:** None

**Files likely touched:**
- `packages/sync/src/entity-extraction/entity-extraction-service.ts` (lines 186-194)
- `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts`

**Estimated scope:** XS (1-2 files)

---

#### Task H: Fix `searchTweets` stale cursor in `fullExtract`

**Description:** `fullExtract` for search queries declares `let cursor: string | undefined` but never updates it — pagination is non-functional. Add a `while` loop: fetch page → yield tweets → extract `next_cursor` from the API response's top-level `search_metadata.next_cursor` field (NOT from tweet IDs or the timeline instructions — SearchTimeline has a different JSON structure than UserTweets). Loop until `next_cursor` is empty/null or page limit reached (5 pages). The `searchTweets()` method must be updated to also return the `next_cursor` alongside tweets.

**Acceptance criteria:**
- [ ] `searchTweets` cursor is extracted from the response `next_cursor` field and fed back
- [ ] Loop terminates when `next_cursor` is empty/null or page limit reached
- [ ] Search query pagination works for `fullExtract`

**Verification:**
- [ ] Unit test: mock `graphqlRequest` with 2 pages of search results → verify cursor propagation
- [ ] Unit test: empty `next_cursor` → loop exits after 1 page
- [ ] `pnpm --filter @openfoundry/sync test` — all tests pass

**Dependencies:** Task G (shares the same testing patterns for pagination)

**Files likely touched:**
- `packages/sync/src/connectors/twitter-connector.ts` (lines 192-198)
- `packages/sync/src/connectors/__tests__/twitter-connector.test.ts`

**Estimated scope:** S (1-2 files)

---

#### Task I: Warn on empty `authorScreenName` + fallback to `rest_id`

**Description:** In `extractTweets()`, if `authorScreenName` resolves to empty string but `rest_id` is available, log a console warning and use `rest_id` as the `author_handle` value. Never silently produce empty strings for identity data.

**Acceptance criteria:**
- [ ] `console.warn()` emitted when `authorScreenName` is empty but `rest_id` is present
- [ ] `author_handle` populated with `rest_id` as fallback
- [ ] Warning includes the `tweet_id` for debugging

**Verification:**
- [ ] Unit test: Twitter response with null `screen_name` path → warning logged, `rest_id` used
- [ ] Unit test: normal response → no warning, `screen_name` used
- [ ] `pnpm --filter @openfoundry/sync test` — all tests pass

**Dependencies:** Task G (same file, but independent change within it)

**Files likely touched:**
- `packages/sync/src/connectors/twitter-connector.ts` (lines 492-496)
- `packages/sync/src/connectors/__tests__/twitter-connector.test.ts`

**Estimated scope:** S (1-2 files)

---

#### Task K: Fix ensemble merge case-only collisions

**Description:** In `ensemble_merge.py:merge()`, add a length-based safety check: if both GLiNER and Flair produce a span with the same normalized key but the original texts have materially different lengths (> 2x difference or one <= 3 chars and the other > 3 chars), keep both as separate entries instead of merging them. This prevents "U.S." (Location, 4 chars) from being lost because "us" (pronoun, 2 chars) has the same lowercased key.

**Acceptance criteria:**
- [ ] `"U.S."` (GLiNER, Location) and `"us"` (Flair, MISC) both survive the merge
- [ ] `"Apple"` (ORG, 5 chars) and `"apple"` (common noun from Flair, 5 chars) still merge (similar length → collision is correct behavior)
- [ ] Existing merge behavior for same-length spans is preserved

**Verification:**
- [ ] Python test: `merge([{"text": "U.S.", "type": "Location", "confidence": 0.9}], [{"text": "us", "type": "Miscellaneous", "confidence": 0.7}])` → 2 results
- [ ] Python test: `merge([{"text": "Bakhmut", "type": "Location", "confidence": 0.9}], [{"text": "Bakhmut", "type": "Location", "confidence": 0.8}])` → 1 result (confirmed)
- [ ] `python -m pytest packages/ner-service/tests/ -v` — all tests pass

**Dependencies:** None (parallel with B, M, N)

**Files likely touched:**
- `packages/ner-service/ensemble_merge.py` (lines 86-91)
- `packages/ner-service/tests/test_ensemble_merge.py`

**Estimated scope:** S (1-2 files)

---

#### Task M: Add 30-second thread timeout to gRPC Stage 1 handler

**Description:** In `server.py:ExtractEntities()`, replace `t.join()` with `t.join(timeout=config.EXTRACTION_TIMEOUT)` (30s). If a thread is still alive after the timeout, log a warning with the thread name and proceed with partial results from whichever model completed.

**Acceptance criteria:**
- [ ] `t.join(timeout=30)` used for both GLiNER and Flair threads
- [ ] `config.EXTRACTION_TIMEOUT = 30` defined in `config.py`
- [ ] Warning logged when a model hangs (thread name included)
- [ ] Partial results returned — if GLiNER hangs, Flair-only entities survive

**Verification:**
- [ ] Python test: mock `threading.Thread` with `is_alive()=True` after join → warning emitted, Flair results returned
- [ ] Python test: normal case → both complete within timeout, full merge
- [ ] `python -m pytest packages/ner-service/tests/ -v` — all tests pass

**Dependencies:** None (parallel with B, K, N)

**Files likely touched:**
- `packages/ner-service/server.py` (lines 114-117)
- `packages/ner-service/config.py`
- `packages/ner-service/tests/` (new test file or extend existing)

**Estimated scope:** S (2-3 files)

---

#### Task N: Replace raw tweet text in WARNING log with fingerprint

**Description:** In `llm_reviewer.py:_parse_llm_response()`, replace `extra={"raw": raw[:200]}` with `extra={"response_length": len(raw), "response_hash": hashlib.sha256(raw.encode()).hexdigest()[:16]}`. Also fix `llm_validation.py` — the file has two additional raw-text log leaks: `source_text[:100]` at line 81 and `str(item)[:200]` at line 47. Replace all three sites with fingerprint-only logging. Import `hashlib` where needed.

**Acceptance criteria:**
- [ ] No raw tweet text in any log output
- [ ] `response_length` and `response_hash` fields present in log
- [ ] Hash is deterministic (SHA-256 truncated to 16 hex chars) — allows correlation across log systems without leaking content

**Verification:**
- [ ] Python test: trigger parse failure → verify log extra has `response_length` and `response_hash`, no `raw` key
- [ ] `python -m pytest packages/ner-service/tests/ -v` — all tests pass
- [ ] Manual: `import hashlib; hashlib.sha256(b"test").hexdigest()[:16]` → works

**Dependencies:** None (parallel with B, K, M)

**Files likely touched:**
- `packages/ner-service/llm_reviewer.py` (line 119)
- `packages/ner-service/tests/test_llm_reviewer.py`

**Estimated scope:** XS (1-2 files)

---

### Checkpoint: Phase 2 complete
- [ ] `pnpm --filter @openfoundry/sync test` — 302+ tests pass
- [ ] `python -m pytest packages/ner-service/tests/ -v` — tests pass
- [ ] DB dedup works across restarts (_normalized_name)
- [ ] Batch dedup: ≤4 queries/tweet
- [ ] Location coords are `null`
- [ ] Twitter pagination works (both incremental + search)
- [ ] Ensemble merge handles case collisions
- [ ] gRPC handler has thread timeout
- [ ] Logs contain no raw tweet content

---

### Phase 3: Integration + server.ts Decomposition (6 tasks, sequential)

---

#### Task J: Decompose `extractTweets()` into private helpers

**Description:** Refactor `extractTweets()` (100+ lines) into 4 private helper methods:
- `getTimelineInstructions(data)` → `Array<Record<string, unknown>>`
- `extractLegacyFromResult(result)` → `Record<string, unknown> | null`
- `extractCoreUserFromResult(result)` → `{ screen_name: string, rest_id: string }`
- `extractEntitiesFromLegacy(legacy)` → `{ hashtags: string[], urls: string[], media_urls: string[] }`

`extractTweets()` should be under 30 lines of orchestration, delegating to these helpers.

**Acceptance criteria:**
- [ ] `extractTweets()` is ≤30 lines
- [ ] 4 private helpers extracted, each ≤30 lines
- [ ] No behavior change — all existing tests pass
- [ ] `authorScreenName` warning from #3 is inlined in `extractCoreUserFromResult()`

**Verification:**
- [ ] `pnpm --filter @openfoundry/sync test` — all tests pass unchanged
- [ ] `wc -l` on the extracted function is ≤30

**Dependencies:** Tasks G, H, I (must be applied to the file first to avoid merge conflicts)

**Files likely touched:**
- `packages/sync/src/connectors/twitter-connector.ts` (lines 426-532)

**Estimated scope:** M (1 file, heavy refactor within it)

---

#### Task O: Extract NER bootstrap from `server.ts`

**Description:** Move ~80 lines of NER pipeline initialization (gRPC client setup, WinkExtractor, GazetteerExtractor, CompositeExtractor, EntityDedupCache, EntityExtractionService instantiation) from `server.ts:567-645` into `packages/api/src/bootstrap/ner-bootstrap.ts`. Export a single `initializeNerPipeline(deps) => EntityExtractionService | null` function. Dependencies (`objectManager`, `linkManager`, `storage`, `logger`) are passed in as parameters. **Critical:** The returned `entityExtractionService` must survive into the changeApplier closure (currently at line ~679) which captures it — after extraction, server.ts still declares the variable and assigns it from the bootstrap call, so the closure continues to work.

**Acceptance criteria:**
- [ ] `ner-bootstrap.ts` exports `initializeNerPipeline()`
- [ ] `server.ts` calls `initializeNerPipeline()` in ~5 lines
- [ ] Graceful degradation preserved — NER disabled with warning on failure
- [ ] `server.ts` is under 1430 lines after extraction (1512 - ~80)

**Verification:**
- [ ] `pnpm run build` succeeds
- [ ] `pnpm --filter @openfoundry/sync test` — all tests pass
- [ ] Manual: start server, verify NER pipeline initializes (log message present)

**Dependencies:** None (but should run before P, Q to progressively reduce server.ts)

**Files likely touched:**
- `packages/api/src/bootstrap/ner-bootstrap.ts` (NEW)
- `packages/api/src/server.ts` (lines 567-645 reductive)

**Estimated scope:** M (2 files)

---

#### Task P: Extract connector wiring from `server.ts`

**Description:** Move connector instantiation, validation, and extraction loop setup from `server.ts` (~lines 647-750) into `packages/api/src/bootstrap/connector-bootstrap.ts`. Export an `initializeConnectors(registry, manifests, deps)` function.

**Acceptance criteria:**
- [ ] `connector-bootstrap.ts` exports `initializeConnectors()`
- [ ] `server.ts` calls it in ~5 lines
- [ ] Connector extraction loops work identically
- [ ] `server.ts` is under 1320 lines after extraction (1430 - ~110)

**Verification:**
- [ ] `pnpm run build` succeeds
- [ ] `pnpm --filter @openfoundry/sync test` — all tests pass
- [ ] Manual: start server, verify connectors initialize and ingest data

**Dependencies:** Task O (to reduce conflicts on server.ts)

**Files likely touched:**
- `packages/api/src/bootstrap/connector-bootstrap.ts` (NEW)
- `packages/api/src/server.ts`

**Estimated scope:** M (2 files)

---

#### Task Q: Extract middleware setup from `server.ts`

**Description:** Move CORS, CSP, rate limiting, GraphQL endpoint configuration, MCP endpoint, health endpoints, and graceful shutdown handler from `server.ts` into `packages/api/src/middleware/setup.ts` (or split into `middleware/setup.ts` + `routes/health.ts` + `routes/mcp.ts` as needed). Export `applyMiddleware(app, options)` and optionally `registerRoutes(app, deps)`. This is the largest extraction — approximately 430 lines moved out of server.ts.

**Acceptance criteria:**
- [ ] `middleware/setup.ts` exports `applyMiddleware()` and optionally `registerRoutes()`
- [ ] `server.ts` calls extracted functions in ~10 lines (multiple calls for middleware + routes + shutdown)
- [ ] All security headers (CSP, CORS) still in effect
- [ ] Health endpoints, MCP endpoint, GraphQL endpoint all functional
- [ ] Graceful shutdown handler extracted and working
- [ ] `server.ts` is **800-900 lines** after extraction (1320 - ~430)

**Verification:**
- [ ] `pnpm run build` succeeds
- [ ] `pnpm --filter @openfoundry/sync test` — all tests pass
- [ ] Manual: `curl -I localhost:4000` → verify CSP + CORS headers present
- [ ] `wc -l packages/api/src/server.ts` → 800-900

**Dependencies:** Tasks O, P (to reduce conflicts on server.ts)

**Files likely touched:**
- `packages/api/src/middleware/setup.ts` (NEW)
- `packages/api/src/server.ts`

**Estimated scope:** M (2 files)

---

#### Task R: Add gRPC retry wrapper with exponential backoff

**Description:** After the NER bootstrap is extracted (Task O), the gRPC fallback lambda in `ner-bootstrap.ts` should use a retry wrapper. Create `packages/api/src/bootstrap/retry.ts` with `withRetry(extractor, maxAttempts=3, baseDelayMs=1000)` that retries **on errors only** (not on empty results — GLiNER legitimately finding nothing is not a failure). Exponential backoff: 1s, 2s, 3s. Does NOT retry on gRPC status `INVALID_ARGUMENT` (bad input — won't improve). Empty results after a successful call simply fall through to compromise (Wink + gazetteer).

**Acceptance criteria:**
- [ ] gRPC extraction retries up to 3 times with backoff (1s, 2s, 3s) on errors
- [ ] Does NOT retry on empty results (empty is valid, not a failure)
- [ ] After all retries exhausted, falls back to compromise (wink-ner + gazetteer)
- [ ] Does NOT retry on gRPC status `INVALID_ARGUMENT` (bad input — won't improve)

**Verification:**
- [ ] Unit test: mock extractor that fails twice then succeeds → 3 calls, result returned
- [ ] Unit test: mock extractor that always returns empty → compromise fallback used
- [ ] Unit test: `INVALID_ARGUMENT` → no retry, immediate fallback
- [ ] `pnpm --filter @openfoundry/sync test` — all tests pass

**Dependencies:** Task O (NER bootstrap must exist for the extractor lambda to be in the right file)

**Files likely touched:**
- `packages/api/src/bootstrap/retry.ts` (NEW)
- `packages/api/src/bootstrap/ner-bootstrap.ts` (modify fallback lambda)
- `packages/api/src/bootstrap/__tests__/retry.test.ts` (NEW)

**Estimated scope:** S (2-3 files)

---

#### Task S: Add JSDoc + guard for `deduplicateOverlappingSpans()` O(n²)

**Description:** Add a JSDoc comment to `deduplicateOverlappingSpans()` documenting the O(n²) characteristic and the assumption that input is bounded by `maxEntities`. Since the function is standalone and doesn't receive `maxEntities`, the guard uses a static cap (e.g., 200) or the function is refactored to accept a `maxInput` parameter:

```typescript
function deduplicateOverlappingSpans(entities: ExtractedEntity[], maxInput = 200): ExtractedEntity[] {
  if (entities.length > maxInput) entities = entities.slice(0, maxInput);
  // ... existing logic
}
```

Update the call site in `processReport()` to pass `this.config.maxEntities * 2`.

**Acceptance criteria:**
- [ ] Function has JSDoc explaining O(n²) time complexity and bound assumption
- [ ] Guard added (belt-and-suspenders)

**Verification:**
- [ ] `pnpm --filter @openfoundry/sync test` — all tests pass
- [ ] Visual review: JSDoc present above function

**Dependencies:** None (safe to do any time after Phase 1)

**Files likely touched:**
- `packages/sync/src/entity-extraction/entity-extraction-service.ts` (lines 29-37)

**Estimated scope:** XS (1 file)

---

#### Task T: Backfill `_normalized_name` for existing entities

**Description:** After the migration (Task A) and write-path fixes (Task D) are complete, existing entities created before the migration have `_normalized_name = NULL`. Write a one-shot TypeScript or SQL script that reads all rows from `person`, `organization`, `location`, `equipment`, `event` tables, computes `normalizeForDedup(type, name_field)` for each, and updates the `_normalized_name` column. The script should use the same `dedup-utils.ts` `normalizeForDedup()` function to guarantee consistency with future writes.

For a clean DB (no existing data), this is a no-op. For databases with existing NER-extracted entities, this ensures cross-restart dedup works for pre-migration data.

**Acceptance criteria:**
- [ ] Backfill script exists and is callable (e.g., `npx tsx tools/backfill-normalized-names.ts`)
- [ ] Uses the same `normalizeForDedup()` as `createEntity()` and `queryByName()`
- [ ] Idempotent — running twice produces identical results
- [ ] Logs count of updated rows per table

**Verification:**
- [ ] Run on a DB with pre-migration entities → `_normalized_name` populated for all rows
- [ ] Run again → zero rows updated (idempotent)
- [ ] `SELECT COUNT(*) FROM person WHERE _normalized_name IS NULL` → 0

**Dependencies:** Tasks A (schema), D (normalizeForDedup extracted and accessible)

**Files likely touched:**
- `tools/backfill-normalized-names.ts` (NEW)
- `packages/sync/src/entity-extraction/dedup-utils.ts` (import only)

**Estimated scope:** S (1-2 files)

---

### Checkpoint: Phase 3 complete (Final)
- [ ] `pnpm --filter @openfoundry/sync test` — 302+ tests pass
- [ ] `python -m pytest packages/ner-service/tests/ -v` — all tests pass
- [ ] `pnpm run build` succeeds
- [ ] `wc -l packages/api/src/server.ts` → 800-900
- [ ] `_normalized_name` backfill complete (0 NULL values in entity tables)
- [ ] All 16 acceptance criteria from spec met
- [ ] Ready for final review

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `_normalized_name` migration requires `docker compose down -v` (volume wipe) | High — loses existing data | Run on clean DB only. Task T (backfill script) handles existing DBs — runs `normalizeForDedup()` on all rows. |
| Extracting `server.ts` sections breaks implicit dependencies (module imports, closure variables) | Medium — build failure | Incremental: extract one section → verify build → commit → next section. Each bootstrap function takes deps as explicit parameters. |
| `_normalizedName` field not in ODL schema → `ObjectManager.create()` drops it | Medium — silent data loss | Task A expanded to include ODL schema declarations. Each entity type's `.odl` file gets the field declared. |
| `normalizeForDedup` is private → `createEntity()` can't call it | Medium — implementation blocked | Task A extracts function to public `dedup-utils.ts` before Tasks D/E/F begin. |
| Python thread timeout may hide real model failures | Low — false negatives | Warning is logged. Health endpoint still reports model as available. Only affects per-request gating, not model lifecycle. |
| Abandoned threads after timeout consume resources | Low — daemon threads | Python can't kill threads. Daemon threads + warning log is the best available mitigation. Threads exit at process shutdown. |
| gRPC retry delays pipeline — worst case 6s (1+2+3) per tweet | Low — gRPC is fast path | Retry only invoked on errors (not empty results). Compromise fallback runs after retries exhausted. 99% of calls are first-attempt success. |

---

## Files Summary

| File | Tasks | Change Type |
|------|-------|-------------|
| `twitter-connector.ts` | C, G, H, I, J | Fix + refactor |
| `entity-dedup.ts` | D, E | Schema-aware refactor |
| `entity-extraction-service.ts` | D, E, F, S | Schema-aware refactor + null fix |
| `server.ts` | O, P, Q | Extraction (reductive) |
| `ner-bootstrap.ts` | O, R | NEW — NER pipeline factory |
| `connector-bootstrap.ts` | P | NEW — connector wiring |
| `middleware/setup.ts` | Q | NEW — middleware setup |
| `retry.ts` | R | NEW — retry wrapper |
| `server.py` | L, M | Fix + refactor |
| `llm_reviewer.py` | L, N | Fix + refactor |
| `ensemble_merge.py` | K, L | Fix + refactor |
| `flair_stage.py` | L | Import refactor |
| `constants.py` | B | NEW — shared constants |
| `config.py` | M | Add timeout constant |
| `*.ddl.sql` (schema) | A | DDL migration + `_normalized_name` field declarations |
| `*.odl` (schema) | A | Field declarations for `_normalized_name` in 5 entity types |
| `docker-compose.yaml` | C, A | Env var, migration trigger |
| `tools/backfill-normalized-names.ts` | T | NEW — one-shot backfill script |
| Test files (7 new/updated) | G, H, I, D, E, F, K, M, N, R | Tests for fixes |

**New files created:** 8 (`ner-bootstrap.ts`, `connector-bootstrap.ts`, `middleware/setup.ts`, `retry.ts`, `dedup-utils.ts`, `constants.py`, `backfill-normalized-names.ts`, Twitter connector test)
**Existing files modified:** 16
**Total files touched:** ~24
