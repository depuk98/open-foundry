# Spec: Session Review Fixes (2026-06-19)

## Objective

Address 16 issues surfaced during two independent five-axis code reviews of the OSINT platform built this session. Issues #1-11 from the primary session review; issues #12-16 validated and merged from a secondary independent review. All fixes are surgical — no new features, no scope creep.

**Who**: Developers and agents maintaining the OSINT platform codebase.

**What success looks like**: All 11 issues resolved, tests still pass (no regressions), code is more maintainable and correct.

---

## Tech Stack

- **TypeScript** — `@openfoundry/sync`, `@openfoundry/api` packages (Node 22, Vitest)
- **Python 3.12** — `packages/ner-service/` (gRPC, pytest)
- **Docker Compose** — deploy stack
- **Vitest** — TypeScript unit/integration tests
- **pytest** — Python unit tests

---

## Commands

```
Build:   pnpm run build
Test:    pnpm --filter @openfoundry/sync test
TestPy:  cd packages/ner-service && python -m pytest tests/ -v
Lint:    pnpm run lint
All:     pnpm run test
```

---

## Project Structure

```
packages/
├── sync/src/
│   ├── connectors/
│   │   └── twitter-connector.ts        ← fixes #1, #2, #3, #6, #11
│   └── entity-extraction/
│       ├── entity-extraction-service.ts ← fixes #4, #16
│       ├── entity-dedup.ts             ← fixes #12, #13
│       └── types.ts
├── api/src/
│   ├── server.ts                       ← refactor #7, #9, #10
│   └── bootstrap/
│       └── ner-bootstrap.ts            ← NEW — extracted from server.ts
└── ner-service/
    ├── server.py                       ← fixes #8, #14
    ├── ensemble_merge.py               ← fix #5
    ├── llm_reviewer.py                 ← fixes #8b, #15
    ├── flair_stage.py                  ← fix #8c
    ├── constants.py                    ← NEW — shared Python constants
    └── tests/
        ├── test_ensemble_merge.py
        └── test_llm_reviewer.py
specs/raw/
└── session-review-fixes.md             ← this file
```

---

## Code Style

**TypeScript** (follows existing convention in `twitter-connector.ts`):
- Clean section headers with `// ─── Section ───`
- Type interfaces defined at top of file
- `async`/`await` with `AbortSignal.timeout()` on all fetch calls
- Snake_case for GraphQL API JSON keys, camelCase for TS identifiers

**Python** (follows existing convention in `server.py`):
- Google-style docstrings
- `list[dict]` for internal data, protobuf types at boundaries
- `dataclass` for structured intermediate results

---

## Testing Strategy

- **Fix #1, #2, #3**: Add unit tests for `TwitterConnector` — mock `graphqlRequest` to return fixture data, verify pagination behavior, verify `authorScreenName` is logged on empty.
- **Fix #4, #5, #16**: Update existing `entity-extraction-service.test.ts` and add `test_ensemble_merge.py` case for case-only collisions. Add test for O(n²) bound guard.
- **Fix #6, #7, #8, #9**: Refactoring — existing tests must pass unchanged (no behavior change).
- **Fix #10**: Add unit test for `CompositeExtractor` retry behavior.
- **Fix #11**: Verify Bearer token is sourced from env, not hardcoded.
- **Fix #12, #13**: Add dedup integration tests — verify `LIKE` query finds title-prefixed names, verify `batchResolve()` generates at most 4 queries for 20 entities.
- **Fix #14**: Add Python test with mock `threading.Thread` that simulates hang, verify timeout triggers and partial results returned.
- **Fix #15**: Verify no raw tweet text in log output — check structlog `extra` keys are `response_length` and `response_hash`, not `raw`.
- **Coverage target**: No net loss. All 302 existing TypeScript tests must pass. Python tests added for #5, #8, #14, #15.

---

## Boundaries

### Always do
- Run `pnpm --filter @openfoundry/sync test` after any TypeScript change
- Run `python -m pytest packages/ner-service/tests/ -v` after any Python change
- Keep existing test behavior — refactoring must be transparent to tests
- Log warnings instead of silently dropping data

### Ask first
- Adding new dependencies
- Changing the Connector interface
- Changing the protobuf schema (`proto/ner.proto`)
- Adding database migrations

### Never do
- Change behavior beyond what the issue describes
- Delete tests to make them pass
- Hardcode credentials
- Skip the Twitter Bearer token fix (#11)

---

## Issues to Resolve

---

### ❌ #1 — Twitter `incrementalExtract` fetches only 1 page per user

**File**: `packages/sync/src/connectors/twitter-connector.ts:226`
**Severity**: 🔴 Critical — silently drops tweets
**Axis**: Correctness

**Current behavior**:
```typescript
const tweets = await this.fetchUserTweets(userId, undefined);
```
No pagination. Fetches exactly 40 tweets (or 0 if empty). High-volume accounts can produce 100+ tweets in a 5-minute cycle.

**Expected**: Paginate through tweets using the returned cursor until either (a) tweets are older than `sinceTweetId`, or (b) we hit a hard page limit (e.g., 5 pages = 200 tweets).

**Acceptance**: After `incrementalExtract` runs, all tweets since the last checkpoint are yielded.

---

### ❌ #2 — Twitter `searchTweets` has a stale-cursor bug

**File**: `packages/sync/src/connectors/twitter-connector.ts:192-198`
**Severity**: 🔴 Critical — pagination is non-functional
**Axis**: Correctness

**Current behavior**:
```typescript
for (const query of this.queries) {
  let cursor: string | undefined;
  const tweets = await this.searchTweets(query, cursor);
  // cursor never updated — loop terminates after 1 call
}
```
`fullExtract` for queries never paginates beyond the first page of results.

**Expected**: Update `cursor` from the API response and loop until no more results (or page limit).

**Acceptance**: Search queries in `fullExtract` paginate through all available results.

---

### ❌ #3 — `authorScreenName` silently returns empty string on null path

**File**: `packages/sync/src/connectors/twitter-connector.ts:492-496`
**Severity**: 🟡 Should Fix — silent data loss
**Axis**: Correctness

**Current behavior**:
```typescript
const authorScreenName = (userResultCore?.["screen_name"] as string) ?? "";
```
If any level of the nested path `result.core.user_results.result.core` is null/undefined, `authorScreenName` becomes `""` with **no warning logged**. The `author_handle` field in the OSINT graph is silently empty.

**Expected**: When `screen_name` can't be resolved, log a warning with the `rest_id` (which may still be available at that point) and fall back to `rest_id` as a display identifier. Never silently produce empty strings for identity data.

**Acceptance**: A console warning is emitted when `authorScreenName` is empty but `rest_id` is available. The `author_handle` field is populated with `rest_id` as fallback.

---

### ❌ #4 — Location entities created with fake coordinates

**File**: `packages/sync/src/entity-extraction/entity-extraction-service.ts:192`
**Severity**: 🟡 Should Fix — misleading data
**Axis**: Correctness

**Current behavior**:
```typescript
location: { latitude: 0, longitude: 0 },
```
NER-extracted locations like "Bakhmut" or "Donetsk" are stored at coordinates `(0, 0)` — Null Island in the Atlantic Ocean. This is factually wrong and can confuse geospatial queries (e.g., "show all locations on map" shows entries in the ocean).

**Expected**: Store coordinates as `null` (or omit the field) until geocoded. Update the `Location` object creation to use `null` for unknown coordinates.

**Acceptance**: NER-created Location entities have `location: null` instead of `{ latitude: 0, longitude: 0 }`.

---

### ❌ #5 — Ensemble merge case-only collisions

**File**: `packages/ner-service/ensemble_merge.py:88,101`
**Severity**: 🟡 Should Fix — edge-case data loss
**Axis**: Correctness

**Current behavior**: Both GLiNER and Flair entries are indexed by `text.strip().lower()`. If GLiNER extracts `"U.S."` (Location) and Flair extracts `"us"` (pronoun, MISC), they collide in the merge dict and only one survives. Similarly, `"Apple"` (ORG) and `"apple"` (common noun) collide.

**Expected**: Add a length-based safety check — if one span is <= 3 chars and the other is > 3 chars, keep both (short spans have higher collision risk). For spans of similar length, the current collision behavior is acceptable.

**Acceptance**: `"U.S."` and `"us"` do not collide. The merge logic preserves both when they're materially different lengths.

---

### ❌ #6 — `extractTweets()` is 100+ lines of deeply nested unwrapping

**File**: `packages/sync/src/connectors/twitter-connector.ts:426-532`
**Severity**: 💡 Consider — readability
**Axis**: Readability

**Current behavior**: One function does: traverse `data.user.result.timeline.timeline.instructions[]` → filter entry types → extract content → unwrap retweets → extract `legacy` → extract `core.user_results` → extract entities/media → build `TweetData`. It's hard to follow, hard to test, and a single null at any level silently drops the tweet.

**Expected**: Extract the result-traversal into private helper methods:
- `getTimelineInstructions(data)` → instructions array
- `extractLegacyFromResult(result)` → legacy blob
- `extractCoreUserFromResult(result)` → `{ screen_name, rest_id }`
- `extractEntitiesFromLegacy(legacy)` → `{ hashtags, urls, media }`

**Acceptance**: `extractTweets()` is under 30 lines, delegating to 3-4 private helpers. Tests pass unchanged.

---

### ❌ #7 — NER setup is embedded inline in `server.ts`

**File**: `packages/api/src/server.ts:567-645`
**Severity**: 💡 Consider — architecture
**Axis**: Architecture

**Current behavior**: ~80 lines of NER pipeline initialization (gRPC client, WinkExtractor, GazetteerExtractor, CompositeExtractor, EntityDedupCache, EntityExtractionService) are written inline in the `createServer` function. This contributes to the god-file problem and makes NER setup hard to test in isolation.

**Expected**: Move NER initialization to `packages/api/src/bootstrap/ner-bootstrap.ts` as an exported `initializeNerPipeline()` factory function that returns `EntityExtractionService | null`.

**Acceptance**: `server.ts` calls `initializeNerPipeline()` in ~5 lines. The bootstrap function is independently testable. `server.ts` is under 1420 lines (pre-#9, post-extraction of NER).

---

### ❌ #8 — Magic strings/numbers and duplicated constants in Python NER modules

**Files**: `packages/ner-service/server.py:47-52`, `llm_reviewer.py:300`, `flair_stage.py:30-35`, `ensemble_merge.py:25-31`
**Severity**: 💡 Consider — readability
**Axis**: Readability

**Three issues consolidated:**

**(A) Magic strings for LLM action values** (`server.py:47-52`, `llm_reviewer.py:251,260,269`)
`_build_proto_entity_from_dict()` and `apply_review()` compare action strings with literal `"correct"`, `"add"`, `"confirm"`. These strings duplicated across modules but not shared.

**(B) Magic number 4 instead of protobuf constant** (`llm_reviewer.py:300`)
```python
if status == 4:  # ENTITY_STATUS_CONFLICT
```
Uses raw integer instead of `ner_pb2.ENTITY_STATUS_CONFLICT`. The proto constant is imported but not used here — a future proto regeneration could change the numeric value.

**(C) Duplicate `FLAIR_TAG_MAP`** (`flair_stage.py:30-35`, `ensemble_merge.py:25-31`)
Two modules define identical `FLAIR_TAG_MAP = {"PER": "Person", ...}` dictionaries. The merge module says this is "for independence" but they can silently diverge.

**Expected**:
- (A) Define module-level constants in a shared `constants.py`:
  ```python
  LLM_ACTION_CONFIRM = "confirm"
  LLM_ACTION_CORRECT = "correct"
  LLM_ACTION_ADD = "add"
  LLM_ACTION_REJECT = "reject"
  ```
- (B) Replace `status == 4` with `status == ner_pb2.ENTITY_STATUS_CONFLICT`
- (C) Move `FLAIR_TAG_MAP` to `constants.py`, import in both modules. If independence from `flair_stage` is desired, add a comment in `constants.py` explaining the coupling.

**Acceptance**: No magic strings or magic numbers in `server.py` or `llm_reviewer.py`. Duplicate `FLAIR_TAG_MAP` eliminated (single source of truth in `constants.py`).

---

### ❌ #9 — `server.ts` is 1512 lines (god file)

**File**: `packages/api/src/server.ts`
**Severity**: 💡 Consider — architecture
**Axis**: Architecture

**Current behavior**: `server.ts` combines HTTP routes, WebSocket, GraphQL, PACL enforcement, connector wiring, NER bootstrap, CORS middleware, CSP headers, MCP endpoint, and graceful shutdown — all in one file.

**Expected**: As a first pass (incremental):
1. Extract NER bootstrap to `bootstrap/ner-bootstrap.ts` (issue #7)
2. Extract connector wiring to `bootstrap/connector-bootstrap.ts`
3. Extract middleware setup (CORS, CSP, rate limiting) to `middleware/setup.ts`

Target: `server.ts` under 600 lines with clear delegations.

**Acceptance**: `server.ts` is at most 600 lines. No behavior change. All tests pass.

---

### ❌ #10 — No gRPC retry with backoff before falling back to compromise

**File**: `packages/api/src/server.ts:615-628` (fallback extractor lambda)
**Severity**: 🟡 Should Fix — performance/availability
**Axis**: Performance

**Current behavior**: The fallback extractor tries gRPC once. If it fails or returns empty, it immediately falls back to compromise (wink-ner + gazetteer). This means any transient gRPC unavailability (e.g., NER service restart, model loading, network blip) permanently degrades extraction quality for that cycle.

**Expected**: Add a retry wrapper around the gRPC call: 3 attempts with 1-second exponential backoff before falling back. Create a `RetryingNerExtractor` wrapper class or a standalone `withRetry()` utility.

```typescript
async function tryGrpcWithRetry(text: string, extractor: EntityExtractor): Promise<ExtractedEntity[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await extractor.extract(text);
      if (result.length > 0) return result;
    } catch {}
    if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
  }
  return [];
}
```

**Acceptance**: gRPC extraction retries up to 3 times with backoff before falling back. Unit test verifies retry behavior with a mock extractor.

---

### ❌ #11 — Hardcoded Twitter Bearer token in source code

**File**: `packages/sync/src/connectors/twitter-connector.ts:329`
**Severity**: 🔴 Critical — security
**Axis**: Security

**Current behavior**:
```typescript
Authorization: "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
```
This is Twitter's public anonymous guest token — it's not a secret per se. However, hardcoding it in source means:
1. It can't be rotated
2. It can't differ between environments
3. It appears in code search/grep results
4. If Twitter deprecates it, a code change is needed

**Expected**: Move the Bearer token to an environment variable `TWITTER_BEARER_TOKEN` with the current value as default in `docker-compose.yaml`. The constructor or `graphqlRequest` reads from `process.env.TWITTER_BEARER_TOKEN` with a hardcoded fallback.

```typescript
const twitterBearerToken = process.env["TWITTER_BEARER_TOKEN"]
  ?? "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
```

**Acceptance**: Bearer token is sourced from `TWITTER_BEARER_TOKEN` env var with a hardcoded fallback. Token value added to `docker-compose.yaml` as an environment variable comment/documentation (not the actual value in env).

---

### ❌ #12 — DB dedup query strips titles but DB stores raw names → cross-restart miss

**File**: `packages/sync/src/entity-extraction/entity-dedup.ts:52-53,62`
**Severity**: 🟡 Should Fix — correctness edge case
**Axis**: Correctness

**Current behavior**: `queryByName()` at line 52 passes the title-stripped name (e.g., `"trump"` for `"President Trump"`) to the SQL query: `LOWER("full_name") = LOWER('trump')`. However, the DB column `full_name` stores the raw unstripped name `"President Trump"`. The exact `LOWER()` match fails, so a cross-restart dedup lookup for an entity created before title-stripping was active will miss the DB record. On a fresh container restart (empty LRU cache), dedup misses Person entries that have title prefixes in `full_name`.

The in-memory cache mitigates this within the same container lifetime — once a Person is in the LRU, it's keyed by stripped name. But across restarts, the DB fallback is ineffective for title-prefixed names.

**Expected**: The DB query should use `LIKE '%' || $2 || '%'` instead of exact `LOWER()` match, or add a `_normalized_name` DB column populated at creation time. The LIKE approach is simpler and handles the `"President Trump"` ↔ `"trump"` case without a schema migration.

```sql
WHERE "_tenant_id" = $1 AND LOWER("full_name") LIKE '%' || LOWER($2) || '%'
```

**Approach selected**: `_normalized_name` column (see [Decision](#decision-normalized_name-column-over-like)). Add a computed `_normalized_name` text column to each entity table (`person`, `organization`, `location`, `equipment`, `event`), populated at creation time using the same `normalizeForDedup()` logic. The column stores the same output as the dedup cache key — Person names title-stripped and lowercased, all other types simply lowercased. DB lookup becomes exact indexed equality:

```sql
WHERE "_tenant_id" = $1 AND "_normalized_name" = $2
```

This eliminates LIKE false positives (e.g., "trumpet" matching "trump") and can use a B-tree index for fast lookups.

**Acceptance**: Cross-restart dedup hits work for title-prefixed Person names. `"President Trump"` in DB is found by lookup for `"trump"`.

---

### ❌ #13 — Per-entity DB query on cache miss (cold-start DB spam)

**File**: `packages/sync/src/entity-extraction/entity-dedup.ts:52`
**Severity**: 💡 Consider — performance
**Axis**: Performance

**Current behavior**: Every entity that misses the in-memory LRU triggers a separate `SELECT` query. For 20 entities per tweet × N tweets/second on a cold start (empty cache), this creates substantial DB load. After cache warm-up this is fine, but initial burst after restart or deployment is heavy.

**Expected**: Batch the `queryByName()` calls into a single query per entity type using `WHERE LOWER("full_name") IN (...)` with all names for that type. Implement a `batchResolve()` method that groups by table+field, sends one query per table, and populates the cache.

```sql
SELECT "_id", "full_name" FROM public.person
WHERE "_tenant_id" = $1 AND LOWER("full_name") IN (LOWER($2), LOWER($3), ...)
AND "_deleted_at" IS NULL
```

**Acceptance**: A single tweet's NER run generates at most 4 DB queries (one per table: person, organization, location, equipment) instead of up to 20 individual queries.

---

### ❌ #14 — Thread join with no timeout in gRPC handler

**File**: `packages/ner-service/server.py:116-117`
**Severity**: 🟡 Should Fix — performance/availability
**Axis**: Performance

**Current behavior**:
```python
for t in threads:
    t.join()
```
`t.join()` blocks the gRPC handler until both GLiNER and Flair threads complete. If one model hangs (GPU lock, OOM, infinite loop in model code), the entire gRPC request hangs forever with no way to recover. Since Python threads can't be killed from outside, the gRPC thread pool worker is stuck permanently.

**Expected**: Add `thread.join(timeout=config.GLINER_TIMEOUT)` with a per-stage timeout (e.g., 30 seconds). If a thread doesn't complete within the timeout, log a warning and proceed with partial results (whichever model finished). Don't try to kill the thread — just move on.

```python
for t in threads:
    t.join(timeout=config.EXTRACTION_TIMEOUT)
    if t.is_alive():
        logger.warning("Stage 1 model hung", extra={"thread": t.name})
```

**Acceptance**: If GLiNER hangs, Flair-only results are returned within 30 seconds. Request never hangs indefinitely.

---

### ❌ #15 — Raw LLM text in WARNING log leaks OSINT tweet content

**File**: `packages/ner-service/llm_reviewer.py:119`
**Severity**: 🟡 Should Fix — security/log hygiene
**Axis**: Security

**Current behavior**:
```python
logger.warning("Failed to parse LLM response JSON", extra={"raw": raw[:200]})
```
When LLM output parsing fails, the first 200 characters of the raw LLM response are logged at WARNING level. The LLM response includes the original tweet text (embedded in `_build_prompt()`), so any OSINT tweet content — including potential PII, classified mentions, or harmful content — leaks into application logs. Logs are less protected than the database and often shipped to centralized aggregators.

**Expected**: Strip the raw content from logs. Replace with a safe fingerprint:
```python
logger.warning("Failed to parse LLM response JSON", extra={
    "response_length": len(raw),
    "response_hash": hashlib.sha256(raw.encode()).hexdigest()[:16],
})
```

**Acceptance**: No raw tweet text appears in log output. Only length + truncated hash fingerprint of the LLM response.

---

### ❌ #16 — `deduplicateOverlappingSpans()` O(n²) — bounded but undocumented

**File**: `packages/sync/src/entity-extraction/entity-extraction-service.ts:29-37`
**Severity**: 💡 Consider — readability/documentation
**Axis**: Readability

**Current behavior**: `deduplicateOverlappingSpans()` uses `filter` + `some` = O(n²) comparisons. For n=20 (max entities capped at `slice(0, maxEntities)`), this is 400 comparisons — acceptable. But the function accepts any length array; it relies on the caller to enforce the bound. A future maintainer might call it with an unbounded array.

**Expected**: Add a JSDoc comment noting the O(n²) assumption and the caller's responsibility for bounding. Optionally add an explicit guard:

```typescript
if (entities.length > this.config.maxEntities * 2) {
  entities = entities.slice(0, this.config.maxEntities * 2);
}
```

**Acceptance**: Function has a doc comment explaining the O(n²) characteristic and that `slice(0, maxEntities)` bounds the input.

---

## Success Criteria

- [ ] All 16 issues addressed with passing tests
- [ ] `pnpm --filter @openfoundry/sync test` — 302+ tests pass (no regressions)
- [ ] `python -m pytest packages/ner-service/tests/ -v` — all Python tests pass
- [ ] `server.ts` is 500-600 lines (down from 1512)
- [ ] No hardcoded Twitter credentials remain in source
- [ ] `twitter-connector.ts` `extractTweets()` is under 30 lines
- [ ] Entity extraction creates Locations with `location: null` for unknown coordinates
- [ ] Ensemble merge handles case-only collisions correctly
- [ ] `incrementalExtract` paginates through all available tweets since checkpoint
- [ ] `searchTweets` paginates correctly with cursor updates
- [ ] NER bootstrap is independently testable
- [ ] DB dedup uses `LIKE` matching → finds title-prefixed Person names across restarts
- [ ] Batch dedup resolves at most 4 DB queries per tweet (one per table)
- [ ] gRPC handler never hangs indefinitely (thread timeout at 30s)
- [ ] No raw tweet content in log output (fingerprint hash only)
- [ ] Python `constants.py` is the single source of truth for shared maps/strings
- [ ] Protobuf constant used instead of magic number `4` in `llm_reviewer.py`

---

## Open Questions

1. **Target line count for server.ts**: ~~Is 900 lines an acceptable intermediate target, or should we go further (500? 300?) in this pass?~~ **Resolved**: Target 500-600 lines for `server.ts`.

2. **Twitter Bearer token fallback**: ~~Should we keep a hardcoded fallback (the current public guest token) or require the env var and fail fast without it?~~ **Resolved**: Keep as-is. The hardcoded public anonymous guest token fallback is acceptable for local dev UX. No change needed for #11 beyond making it env-overridable.

3. **Location coordinates**: ~~Should we add a geocoding step (e.g., Nominatim) for known location entities?~~ **Resolved**: Keep as-is. The `null` coordinates fix (#4) is sufficient. Geocoding is future work.

4. **Retry for gRPC fallback**: ~~Is 3 retries with 1s backoff the right balance? Could be 2 retries with 500ms to avoid delaying the pipeline too much.~~ **Resolved**: 3 retries with 1s exponential backoff is confirmed.

5. **DB LIKE vs normalized column (#12)**: ~~`LIKE '%trump%'` vs `_normalized_name` column?~~ **Resolved**: Use `_normalized_name` column approach. See detailed design in [Decision](#decision-normalized_name-column-over-like). Add a computed `_normalized_name` text column to `person`, `organization`, `location`, `equipment`, `event` tables. Populated at creation time using the same `normalizeForDedup()` function. DB query becomes exact `=` match with B-tree index — no false positives, no LIKE overhead.

6. **Thread timeout value (#14)**: ~~Is 30 seconds per model reasonable?~~ **Resolved**: 30 seconds confirmed. Covers worst-case model load spikes without false timeouts.
