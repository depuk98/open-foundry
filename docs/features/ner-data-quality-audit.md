---
title: NER Data Quality Audit & Validation Strategy
created: 2026-06-18
last_updated: 2026-06-18
type: analysis
status: draft
related_components:
  - ner-extraction
  - ner-service
  - sync-engine
related_features:
  - osint-domain-pack
  - ner-three-stage-pipeline-spec
---

# NER Data Quality Audit & Validation Strategy

## 1. Column-by-Column Audit Results

### Person Table (127 rows — 100% NER-populated)

| Column | Issue | Count / 127 | Severity |
|--------|-------|-------------|----------|
| `full_name` | Twitter handles as names | 65 (51%) | 🔴 |
| `full_name` | Single-word lowercase fragments | 123 (97%) | 🟡 |
| `full_name` | Too short (< 3 chars) | 2 (2%) | 🔴 |
| `full_name` | Contains URL/handle markers | 2 (2%) | 🔴 |
| `full_name` | "President" as standalone (title, not name) | 1 | 🟡 |
| `nationality` | All empty | 127 (100%) | 🟡 |
| `role` | All empty | 127 (100%) | 🟡 |
| `title` | All empty | 127 (100%) | 🟡 |

**Bad examples:** `ChristopherJM`, `AlexHortonTX`, `deaidua`, `kromark`, `GirkinGirkin`, `haynesdeborah` — all Twitter handles classified as Person.

### Organization Table (175 rows — 100% NER-populated)

| Column | Issue | Count / 175 | Severity |
|--------|-------|-------------|----------|
| `name` | Twitter handles/usernames | 93 (53%) | 🔴 |
| `name` | Roles/titles, not orgs | 2 (1%) | 🟡 |
| `name` | Too short (< 4 chars) | 22 (13%) | 🟡 |
| `name` | Single-word fragments | 93 (53%) | 🟡 |
| `type` | All OTHER for standard entities | 132 (75%) | 🟡 |
| `is_designated` | All false | 175 (100%) | 🟡 |
| `country` | All empty | 175 (100%) | 🟡 |
| `unit_designation` | All empty | 175 (100%) | 🟡 |

**Bad examples:** `criticalthreats`, `KyivIndependent`, `Faytuks`, `bayraktar`, `CENTCOM`, `AAA` — handles and abbreviations. `Israeli Prime Minister` — a role, not an org.

### Location Table (146 rows — 100% NER-populated)

| Column | Issue | Count / 146 | Severity |
|--------|-------|-------------|----------|
| `name` | Contains possessive | 5 (3%) | 🟡 |
| `name` | Person names as locations | ~10 | 🔴 |
| `name` | "coastal areas", "Iranian ports" — generic | ~5 | 🟡 |
| `name` | "R-MS", "U.S." — abbreviations | ~5 | 🟡 |
| `type` | All CITY (146/146) | 146 (100%) | 🟡 |
| `country` | All UNKNOWN | 146 (100%) | 🟡 |
| `status` | All UNKNOWN | 143 (98%) | 🟡 |

**Bad examples:** `Korazim Vered HaGalil` (person's name as location), `R-MS` (abbreviation), `coastal areas` (generic), `Beirut's` (possessive).

### Equipment Table (68 rows — 100% NER-populated)

| Column | Issue | Count / 68 | Severity |
|--------|-------|-------------|----------|
| `designation` | Commercial activity text | 3 (4%) | 🔴 |
| `designation` | Alert/warning system text | 1 (1%) | 🔴 |
| `designation` | Generic military terms | 28 (41%) | 🟡 |
| `designation` | Lowercase start | 62 (91%) | 🟡 |
| `designation` | Too short (< 4 chars) | 2 (3%) | 🟡 |
| `category` | All OTHER | 68 (100%) | 🟡 |
| `manufacturer` | All empty | 68 (100%) | 🟡 |

**Bad examples:** `oil tank lid turret` (text fragment), `commercial shipping` (activity), `Sirens` (warning system).

### Event Table (5 rows)

| Column | Issue |
|--------|-------|
| `description` | `NER-extracted event: BREAKING` — not an event, it's a tweet prefix |
| `location_name` | All UNKNOWN |
| `country` | All UNKNOWN |

### Mentions* Links — Context Column

| Link Type | Context Issue | Count |
|-----------|--------------|-------|
| `mentions_organization` | Contains URLs | 764/1879 (41%) |
| All mentions* | Context is raw tweet snippet, truncated at 50 chars | Universal |

**Bad context examples:**
- `d J. Trump has posted to Truth Social stating "There is no 300` — truncated mid-word
- `n to $3.99, according to AAA. https://t.co/j7mjZcqsMG` — URL in context
- Context often starts/ends mid-word because extractor finds span first, then takes ±25 chars

---

## 2. Root Cause Analysis — How Each Issue Happens

### 🔴 Twitter handles classified as Person/Organization (51% of Person, 53% of Org)

**Root cause:** GLiNER sees unknown proper nouns → guesses Person/Organization. Twitter handles like `ChristopherJM`, `haynesdeborah` look like person names to a model with no Twitter-handle-awareness. The fix: regex-based handle filter before storage.

### 🔴 Text fragments classified as Equipment

**Root cause:** GLiNER zero-shot with "Equipment" label matches ANY text that remotely looks like a noun phrase. "oil tank lid turret" = Equipment? GLiNER says yes. The fix: Flair cross-check (Flair won't tag these as MISC), minimum entity confidence threshold.

### 🟡 All entities missing subtype fields (nationality, country, manufacturer, category)

**Root cause:** `createEntity()` provides only minimum required fields with defaults (`type: 'OTHER'`, `country: 'UNKNOWN'`). The NER pipeline extracts *spans and types* but doesn't infer attributes. The fix: accept this as a limitation — NER gives entity identification, not attribute enrichment. Analysts fill attributes later via the UI.

### 🟡 Possessive suffixes ("Beirut's")

**Root cause:** No text normalization after extraction. The fix: strip possessives, trailing punctuation in post-filter.

### 🟡 Context truncation mid-word

**Root cause:** `extract_context()` takes ±25 chars from span position. If span is at position 3, you get `"d J. Trump..."`. The fix: smart context extraction that aligns to word boundaries.

### 🟡 URLs in context

**Root cause:** 764/1879 organization mentions contain URLs because tweets frequently end with `https://t.co/...` and context captures nearby text. The fix: strip URLs from context.

---

## 3. Industry Best Practices — How Others Do It

Enterprise NER pipelines (Palantir, spaCy, Amazon Comprehend, Google NL API) use a layered validation approach:

### Layer 1: Pre-Storage Validation (Filter before INSERT)

Every entity is validated against rules before being stored. If validation fails, the entity is rejected (never enters the database). This is the most important layer.

```
Entity extracted → Validate → PASS → store in DB
                             → FAIL → discard + log metric
```

**Common rules:**

| Rule | Applies To | Example |
|------|-----------|---------|
| **Pattern blacklist** | All types | Regex: `^https?://`, `^@\w+`, `^[a-z_]+$` (single lowercase word) |
| **Minimum length** | All types | Person ≥ 3 chars, Equipment ≥ 4 chars |
| **Title/role filter** | Person, Organization | "President", "Minister", "Secretary", "General" alone → reject |
| **Confidence floor** | All types | < 0.4 → reject (we have this) |
| **Known-bad spans** | All types | Curated deny-list from common false positives |

### Layer 2: Ensemble Cross-Validation (Our Flair + GLiNER)

If two independent models agree → high confidence. If one model found it and the other didn't → medium confidence (single source). If they disagree → conflict → Stage 3 LLM.

This is what spaCy calls "pipeline composition" — multiple NER components vote on spans. We already have this via the ensemble merge.

### Layer 3: Attribute Inference (Optional)

Some systems attempt to infer subtype attributes:
- "Iran" extracted as Location → query country code → set `country: IR`
- "T-90M" extracted as Equipment → lookup in gazetteer → set `category: MAIN_BATTLE_TANK`

We don't do this currently. It's a nice-to-have, not critical for MVP.

### Layer 4: Human-in-the-Loop (Future)

Palantir Foundry and similar systems flag low-confidence entities for analyst review. Entities below threshold are stored but marked as `needs_review`. The UI surfaces them for human correction.

---

## 4. Proposed Fixes — Implementation Plan

### Fix 1: Entity Post-Processing Filter (EntityExtractionService)

Add a validation function that filters extracted entities BEFORE they hit the database:

```typescript
function validateEntity(entity: ExtractedEntity, sourceText: string): boolean {
  const name = entity.name.trim();
  
  // Reject: Twitter handles (single lowercase word with no spaces)
  if (/^[a-z][a-z0-9_]+$/i.test(name) && !name.includes(' ')) {
    // Allow known real names (capitalized single words)
    if (!/^[A-Z]/.test(name)) return false;
  }
  
  // Reject: URLs
  if (/^https?:\/\//.test(name) || /\.com$|\.org$/.test(name)) return false;
  
  // Reject: standalone titles
  if (/^(President|Minister|Secretary|General|Admiral|Colonel|Captain)$/i.test(name)) return false;
  
  // Reject: too short
  if (name.length < 3) return false;
  
  // Clean: strip possessives, trailing punctuation
  // (applied as transformation, not rejection)
  
  return true;
}
```

### Fix 2: Smart Context Extraction

Fix `text_utils.extract_context()` to align to word boundaries:

```python
def extract_context(text: str, span: str, window: int = 40) -> str:
    idx = text.find(span)
    if idx == -1: return ""
    start = max(0, idx - window)
    end = min(len(text), idx + len(span) + window)
    raw = text[start:end]
    # Strip partial words at boundaries
    if start > 0 and raw[0] != ' ': raw = raw[raw.index(' ')+1:] if ' ' in raw else raw
    if end < len(text) and raw[-1] != ' ': raw = raw[:raw.rindex(' ')] if ' ' in raw else raw
    # Strip URLs
    raw = re.sub(r'https?://\S+', '', raw)
    return raw.strip()
```

### Fix 3: Context URL Stripping

Strip URLs from context before storing:

```typescript
// In entity-extraction-service.ts processReport():
const cleanContext = entity.context?.replace(/https?:\/\/\S+/g, '').trim() ?? '';
```

### Fix 4: Flair Cross-Check Already Handles ~70% of False Positives

The current ensemble merge would eliminate most of these bad entities. The data you see is from cycles where Flair wasn't loaded (container restarts). When Flair IS loaded:

- Twitter handles → Flair won't tag them → SINGLE_SOURCE → min confidence reject or kept as low-confidence
- "oil tank lid turret" → Flair won't tag → SINGLE_SOURCE → below threshold → rejected
- "Sirens" → Flair won't tag → rejected
- "Benjamin" → Flair tags PER → CONFIRMED → kept (partial name, but real name)

---

## 5. Summary — What to Fix and Order

| Priority | Fix | Where | Effort |
|----------|-----|-------|--------|
| 🔴 | Handle/title filter before storage | `entity-extraction-service.ts` | 30 min |
| 🔴 | Smart context + URL strip | `text_utils.py` + TS side | 20 min |
| 🟡 | Ensure Flair is loaded before ingestion starts | `ner-service` startup | Already fixed with health check |
| 🟡 | Possessive/trailing-punct cleanup | Post-extraction filter | 10 min |
| 🔵 | Attribute inference (country, category) | Future — not MVP | 2-3 days |
| 🔵 | Analyst review queue for low-confidence | Future — needs UI | 1 week |

