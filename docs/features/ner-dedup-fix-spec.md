---
title: NER Entity Deduplication Fix — Specification
created: 2026-06-18
last_updated: 2026-06-18
type: spec
status: draft
related_components:
  - ner-extraction
  - sync-engine
related_features:
  - osint-domain-pack
  - ner-data-quality-audit
---

# Spec: NER Entity Deduplication Fix

## 1. Objective

When GLiNER extracts `"Gen Keane"` and `"Keane"` from the same tweet, both are stored as separate Person rows. When it extracts `"President Trump"` and `"Trump"`, the same happens. Same for `"Hassan Nasrallah"` and `"Nasrallah"`. 

**What we're building:** Two-layer dedup that catches these near-duplicates BEFORE they reach the database. Layer 1 eliminates substring overlaps within the same tweet. Layer 2 normalizes names before computing the dedup cache key so title-prefixed names match their bare counterparts.

**Who this is for:** The knowledge graph — preventing duplicate entity creation at the source.

**Success looks like:** `"Gen Keane"` and `"Keane"` from the same tweet → one entity stored. `"President Trump"` and `"Trump"` → one entity stored. DB audit shows zero near-duplicate entities from same-tweet extractions.

## 2. The Problem — Illustrated

```
Tweet: "General Keane told reporters that Keane would visit Kyiv."

GLiNER extracts:  [Person] "General Keane" (confidence: 0.95)
                  [Person] "Keane"         (confidence: 0.89)

Current dedup:    key1 = "Person:general keane" → NULL → CREATE row1
                  key2 = "Person:keane"          → NULL → CREATE row2

Problem: Two rows for the same person.
```

## 3. Architecture — Two-Layer Fix

```
Tweet processed
    │
    ▼
GLiNER + Flair extract entities
    │
    ▼
┌─────────────────────────────┐
│ Layer 1: Intra-Text Span     │  ← NEW
│ Dedup                        │
│                              │
│ For each entity, check if    │
│ its span is a substring of   │
│ another entity in the same   │
│ tweet. Keep only the longer. │
│                              │
│ "Keane" ⊂ "General Keane"    │
│ → discard "Keane"            │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Layer 2: Normalized Cache    │  ← NEW
│ Key                          │
│                              │
│ Before looking up dedup      │
│ cache, strip known title     │
│ prefixes from the name.      │
│                              │
│ "General Keane" → normalize  │
│ → "Keane"                    │
│ "Keane" → normalize          │
│ → "Keane"                    │
│                              │
│ Both produce same cache key: │
│ "Person:keane"               │
│ → Second is dedup HIT        │
└──────────────┬──────────────┘
               │
               ▼
Dedup Cache (exact match — same as before)
    │
    ▼
createEntity() OR reuse existing ID
```

## 4. Implementation Detail

### Layer 1: Intra-Text Span Dedup

**Location:** `EntityExtractionService.processReport()`, after confidence filter, before the storage loop.

```
Input:  entities = [{name:"General Keane", type:"Person", ...},
                    {name:"Keane", type:"Person", ...},
                    {name:"Bakhmut", type:"Location", ...}]

Step 1: For each pair of same-type entities, check substring containment
        "Keane" is substring of "General Keane" → same type → remove "Keane"

Step 2: If both contain each other (same name) → keep the higher confidence one

Output: entities = [{name:"General Keane", type:"Person", ...},
                    {name:"Bakhmut", type:"Location", ...}]
```

**Rules:**
- Only dedup entities with the SAME type. `"Trump"` (Person) and `"Trump Org"` (Organization) are NOT duplicates — different types.
- When two spans overlap as substring, keep the LONGER span (more complete information).
- When two spans are identical, keep the higher confidence.
- This runs BEFORE validation (so rejected entities don't shadow valid ones).

### Layer 2: Title-Stripping Cache Key

**Location:** `EntityDedupCache.resolve()` and `set()` — modify the key computation.

```typescript
// Current:
const key = `${type}:${name.toLowerCase()}`;

// Fixed:
const key = `${type}:${normalizeForDedup(name).toLowerCase()}`;

function normalizeForDedup(name: string): string {
  return name.replace(
    /^(President|General|Gen|Admiral|Colonel|Captain|Major|Lieutenant|Lt|Sergeant|Sgt|Secretary|Minister|Dr|Mr|Ms|Mrs|King|Queen|Prince|Princess|Sheikh|Ayatollah|Crown Prince)\s+/i,
    ''
  ).trim();
}
```

**Title stripping list** — these are known titles that don't change the identity of the entity:

| Title | Strips to | Example |
|-------|----------|---------|
| `President` | bare name | `President Trump` → `Trump` |
| `General` / `Gen` | bare name | `Gen Keane` → `Keane` |
| `Minister` | bare name | `Minister Austin` → `Austin` |
| `Secretary` | bare name | `Secretary Blinken` → `Blinken` |
| `Dr` / `Mr` / `Ms` / `Mrs` | bare name | `Dr Fauci` → `Fauci` |
| `King` / `Queen` / `Prince` | bare name | `King Charles` → `Charles` |
| `Ayatollah` / `Sheikh` | bare name | `Ayatollah Khamenei` → `Khamenei` |

**Important edge case:** `"President"` alone (the title-only validation filter already rejects this). But `"Minister"` as an Organization name should NOT be stripped — the normalization only applies to Person-type entities. Wait, actually the dedup cache is shared across ALL types. So `"Minister"` (Org) and `"Minister Austin"` (Person) would collide on the same key. 

**Fix:** Only apply title stripping for Person, MilitaryUnit, ArmedGroup types. Organization and Location names are NOT title-stripped (a company called "General Electric" should not become "Electric").

```typescript
function shouldStripTitle(type: string): boolean {
  return ['Person', 'MilitaryUnit', 'ArmedGroup'].includes(type);
}
```

## 5. Tech Stack

- TypeScript — `packages/sync/src/entity-extraction/`
- Existing files modified: `entity-dedup.ts`, `entity-extraction-service.ts`
- No new dependencies
- No database changes

## 6. Commands

```
Build:   cd packages/sync && pnpm run build
Test:    cd packages/sync && pnpm run test
Typecheck: cd packages/sync && pnpm run typecheck
Deploy:  cd deploy && docker compose build api-gateway && docker compose up -d api-gateway
Audit:   PGPASSWORD=changeme psql -h localhost -p 5433 -U openfoundry -d openfoundry
         -c "SELECT a.full_name, b.full_name FROM person a JOIN person b
             ON (LOWER(a.full_name) LIKE '%' || LOWER(b.full_name) || '%'
             AND a.full_name != b.full_name)"
```

## 7. Project Structure

```
packages/sync/src/entity-extraction/
├── entity-dedup.ts              ← MODIFY: title-stripping in cache key
├── entity-extraction-service.ts ← MODIFY: intra-text span dedup
├── __tests__/
│   ├── entity-dedup.test.ts     ← MODIFY: add title-strip tests
│   └── entity-extraction-service.test.ts ← MODIFY: add span dedup tests
```

## 8. Code Style

Layer 1 — simple filter, pure function:

```typescript
function deduplicateOverlappingSpans(entities: ExtractedEntity[]): ExtractedEntity[] {
  const result: ExtractedEntity[] = [];
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    // Check if this span is contained within another same-type entity
    const isContained = entities.some((other, j) =>
      i !== j &&
      entity.type === other.type &&
      other.name.toLowerCase().includes(entity.name.toLowerCase()) &&
      other.name.length > entity.name.length
    );
    if (!isContained) {
      result.push(entity);
    }
  }
  return result;
}
```

Layer 2 — cache key normalization:

```typescript
const TITLE_PATTERN = /^(President|General|Gen|Admiral|Colonel|Captain|Major|Lieutenant|Lt|Sergeant|Sgt|Secretary|Minister|Dr|Mr|Ms|Mrs|King|Queen|Prince|Princess|Sheikh|Ayatollah|Crown Prince)\s+/i;
const TITLE_STRIP_TYPES = new Set(['Person', 'MilitaryUnit', 'ArmedGroup']);

function normalizeForDedup(name: string, type: string): string {
  if (TITLE_STRIP_TYPES.has(type)) {
    return name.replace(TITLE_PATTERN, '').trim();
  }
  return name.trim();
}
```

## 9. Testing Strategy

- **Framework:** vitest (existing)
- **Tests to add:** ~15
- **Coverage:** Each scenario below has at least one positive test

### Layer 1 Test Scenarios

| Test | Input | Expected Output |
|------|-------|----------------|
| Substring same type kept | `[Person:"Gen Keane", Person:"Keane"]` | `[Person:"Gen Keane"]` |
| Substring different type kept | `[Person:"Trump", Org:"Trump Org"]` | Both kept — different types |
| No overlap | `[Person:"Biden", Person:"Putin"]` | Both kept |
| Three-way overlap | `[Person:"Hassan Nasrallah", Person:"Nasrallah", Person:"Hassan"]` | `[Person:"Hassan Nasrallah"]` |
| Exact duplicate | `[Person:"Keane", Person:"Keane"]` | `[Person:"Keane"]` (one) |
| Clean names from validation | `[Person:"Beirut", Location:"Beirut"]` | Both kept — different types |

### Layer 2 Test Scenarios

| Test | Input | Type | Normalized Key |
|------|-------|------|---------------|
| President stripped | `"President Trump"` | Person | `person:trump` |
| Gen stripped | `"Gen Keane"` | Person | `person:keane` |
| Title not stripped for Org | `"General Electric"` | Organization | `organization:general electric` |
| Multi-word title | `"Crown Prince Mohammed"` | Person | `person:mohammed` |
| No title | `"Zelensky"` | Person | `person:zelensky` |

## 10. Boundaries

**Always do:**
- Run intra-text dedup on every extraction batch
- Normalize cache keys using the same function for both resolve() and set()
- Only dedup same-type entities (Person with Person, not Person with Org)

**Ask first:**
- Adding new title words to the strip list (may affect existing cached entities)
- Changing the substring containment logic (could miss or over-match)

**Never do:**
- Strip titles from Organization or Location names
- Modify the stored entity name — only the cache key changes
- Run fuzzy matching on every insert (too expensive)

## 11. Success Criteria

- [ ] `"Gen Keane"` + `"Keane"` from same tweet → only `"Gen Keane"` stored
- [ ] `"President Trump"` + `"Trump"` from same tweet → only `"President Trump"` stored
- [ ] `"Hassan Nasrallah"` + `"Nasrallah"` from same tweet → only `"Hassan Nasrallah"` stored
- [ ] `"Trump"` (Person) + `"Trump Org"` (Organization) → BOTH stored (different types)
- [ ] `"General Electric"` (Organization) → NOT stripped to `"Electric"`
- [ ] Title-stripped dedup: clean DB → ingest → no near-duplicate Person rows
- [ ] All 287 existing tests pass
- [ ] Audit shows 0 substring-overlap Person entities from same-tweet extractions

## 12. Trade-offs

| Approach | Pro | Con | Chosen? |
|----------|-----|-----|---------|
| Intra-text span dedup (Layer 1) | Eliminates exact pattern. Zero false positives. | Only works within same tweet, not across tweets. | ✅ Yes |
| Title-strip cache key (Layer 2) | Works across all tweets. Simple. | Strips "General" from "General Dynamics" if typed as Person by mistake. Low risk — validation filter catches mistyped entities. | ✅ Yes |
| Fuzzy DB search (pg_trgm) | Catches everything. | Slow per-insert. Adds PostgreSQL extension dependency. Needs periodic batch job. | ❌ No — future if needed |
| Context-aware dedup | Most accurate. | Too heavy for per-tweet pipeline. | ❌ No |
| Entity linking to KB | Gold standard. | Requires knowledge base + linker model. Overkill. | ❌ No |

## 13. Open Questions

- [ ] Should intra-text dedup be configurable per-connector (via YAML) like validation rules?
- [ ] Should we also run a periodic batch merge job for cross-tweet duplicates?

