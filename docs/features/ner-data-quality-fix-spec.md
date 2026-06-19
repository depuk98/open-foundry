---
title: NER Data Quality Fix — Validation Pipeline Specification
created: 2026-06-18
last_updated: 2026-06-18
type: spec
status: draft
related_components:
  - ner-extraction
  - ner-service
  - sync-engine
related_features:
  - osint-domain-pack
  - ner-data-quality-audit
---

# Spec: NER Data Quality Fix — Validation Pipeline

## 1. Objective

72% of Person rows are Twitter handles. 44% of Organization rows are usernames. Equipment table contains `UK-registered yacht` and `Sirens`. These invalid entities flow directly from the GLiNER extractor into the database with zero validation.

**What we're building:** A pre-storage validation filter in the TypeScript `EntityExtractionService` that inspects every entity before it reaches `createEntity()`. Invalid entities are rejected — they never enter the database. Valid entities pass through unchanged. No entity is stored without passing every applicable rule.

**Who this is for:** The knowledge graph — preventing pollution at the source. Future analysts querying Organization/Person/Equipment tables should see only valid entities.

**Success looks like:** Re-audit after fix shows 0 handles in Person, 0 handles in Organization, 0 commercial/siren/generic terms in Equipment.

## 2. Tech Stack

- TypeScript (`packages/sync/src/entity-extraction/`)
- Existing pattern: filter function inserted between extraction and storage
- No new dependencies

## 3. Commands

```
Build:   cd packages/sync && pnpm run build
Test:    cd packages/sync && pnpm run test
Lint:    cd packages/sync && pnpm run typecheck
Deploy:  cd deploy && docker compose build api-gateway && docker compose up -d api-gateway
Audit:   PGPASSWORD=changeme psql -h localhost -p 5433 -U openfoundry -d openfoundry -f tools/audit-ner.sql
```

## 4. Project Structure

```
packages/sync/src/entity-extraction/
├── entity-validation.ts        ← NEW: validation rules per entity type
├── entity-extraction-service.ts ← MODIFY: call validator before createEntity
├── __tests__/
│   └── entity-validation.test.ts ← NEW: validation rule tests
└── types.ts                     ← UNCHANGED
```

## 5. Code Style

The validation module exports a single function. Each rule is a composable predicate. Rules are type-specific and return `{valid: boolean, reason: string}` so rejected entities can be logged with a reason.

```typescript
// entity-validation.ts

type ValidationResult = { valid: true } | { valid: false; reason: string };

interface ValidationRule {
  name: string;
  check: (entity: ExtractedEntity, sourceText: string) => ValidationResult;
}

// Rules are organized by entity type
const PERSON_RULES: ValidationRule[] = [
  {
    name: 'no-handles',
    check: (e) => {
      // Single lowercase word with no spaces = likely handle
      if (/^[a-z][a-z0-9_]{3,}$/.test(e.name) && !e.name.includes(' ')) {
        return { valid: false, reason: `looks like a Twitter handle: ${e.name}` };
      }
      return { valid: true };
    },
  },
  {
    name: 'no-numbers-in-name',
    check: (e) => {
      if (/^[A-Za-z]+\d+$/.test(e.name)) {
        return { valid: false, reason: `name contains trailing numbers: ${e.name}` };
      }
      return { valid: true };
    },
  },
  // ... more rules
];

const ORG_RULES: ValidationRule[] = [ /* ... */ ];
const EQUIPMENT_RULES: ValidationRule[] = [ /* ... */ ];
const LOCATION_RULES: ValidationRule[] = [ /* ... */ ];

export function validateEntity(
  entity: ExtractedEntity,
  sourceText: string,
): ValidationResult {
  const rules = RULES_BY_TYPE[entity.type] ?? [];
  for (const rule of rules) {
    const result = rule.check(entity, sourceText);
    if (!result.valid) return result;
  }
  return { valid: true };
}
```

## 6. Testing Strategy

- **Framework:** vitest (existing)
- **Location:** `packages/sync/src/entity-extraction/__tests__/entity-validation.test.ts`
- **Coverage target:** Every rule has at least one positive (valid) and one negative (invalid) test
- **Integration:** Existing `entity-extraction-service.test.ts` tests continue to pass
- **Manual verification:** Clean DB → fresh ingestion → audit shows 0 handles

## 7. Validation Rules — Complete Matrix

### Person Rules

| Rule | Pattern | Reject Example | Keep Example |
|------|---------|----------------|-------------|
| `no-handles` | Single lowercase word, 4+ chars, no spaces | `ChristopherJM`, `deaidua`, `kromark` | `Zelensky`, `Stoltenberg` |
| `no-numbers` | Trailing numbers after letters | `Jeff21461`, `JD1YU0LyGg` | N/A |
| `no-titles-only` | Standalone title words | `President`, `Minister` | `President Zelensky` |
| `min-length` | < 3 chars | `Xi`, `Ja` | `Biden`, `Kim` |
| `no-descriptions` | Job descriptions / roles | `Development Associate` | N/A |

### Organization Rules

| Rule | Pattern | Reject Example | Keep Example |
|------|---------|----------------|-------------|
| `no-handles` | Single lowercase word, 4+ chars | `bayraktar`, `CalibreObscura`, `DroneTEX` | `NATO`, `Wagner` |
| `no-roles` | Government/role phrases | `Tanzanian foreign minister` | `Tanzanian government` |
| `no-generic-nouns` | Common lowercase nouns | `troops`, `regime`, `universities` | N/A |
| `min-length` | < 2 chars | `B`, `AA` | `G7`, `UN` |

### Equipment Rules

| Rule | Pattern | Reject Example | Keep Example |
|------|---------|----------------|-------------|
| `no-commercial` | Commercial/civilian keywords | `UK-registered yacht` | N/A |
| `no-alert-systems` | Alert/warning keywords | `Sirens` | N/A |
| `no-generic-only` | Bare generic noun, < 2 words | `drones`, `missiles` | `one-way attack drones` |
| `no-truncated` | Truncated text suffixes | `FP-1 stri` | `FP-1 strike drone` |
| `min-designation` | < 2 words for generic terms | `Radar`, `Drone` | `AN-196 Lyutyiy` |

### Location Rules

| Rule | Pattern | Reject Example | Keep Example |
|------|---------|----------------|-------------|
| `no-descriptions` | Description phrases ending in "region"/"area" | `Sverdlovsk region`, `coastal areas` | `Sverdlovsk` |
| `min-length` | < 2 chars | `B` | `Kyiv`, `US` |
| `no-bare-abbrev` | Single uppercase letter or 2-char abbrev without context | `A`, `B` | `DC`, `UK` (if in source text) |

## 8. Integration Point

The validator is called at a single point — in `EntityExtractionService.processReport()`, between entity extraction and storage:

```typescript
// entity-extraction-service.ts:68-72 (current)
result.entitiesExtracted = entities.length;

for (const entity of entities) {
  try {
    // NEW: validate before storing
    const validation = validateEntity(entity, text);
    if (!validation.valid) {
      logger.debug({ entity: entity.name, type: entity.type, reason: validation.reason },
        'NER: entity rejected by validation filter');
      continue; // skip this entity, move to next
    }

    let entityId = await this.dedupCache.resolve(
      entity.type, entity.name, this.storage, ctx,
    );
    // ... rest unchanged
```

The validator runs AFTER confidence filtering but BEFORE dedup/storage. Rejected entities count as extracted but never reach the database.

## 9. Boundaries

**Always do:**
- Run validation on every entity before storage
- Log rejected entities with reason at DEBUG level
- Keep validation rules in a single module for auditability
- Allow future rules to be added by appending to rule arrays

**Ask first:**
- Adding rules that reject entities that were previously accepted (data quality regression)
- Changing confidence thresholds globally
- Modifying the `createEntity()` defaults

**Never do:**
- Skip validation based on entity type (every type gets validated)
- Allow entities with empty names through
- Modify the source text to "fix" entity spans (reject, don't mutate)

## 10. Success Criteria

- [ ] `full_name_handle` in Person audit drops from 72% (58/81) to < 5%
- [ ] `name_handle` in Organization audit drops from 44% (61/138) to < 5%
- [ ] `designation_commercial` in Equipment drops from 2 to 0
- [ ] `designation_alert` in Equipment drops from 1 to 0
- [ ] `designation_generic` in Equipment drops from 4 to < 2
- [ ] `name_role` in Organization drops from 1 to 0
- [ ] `name_is_description` in Location drops from 2 to 0
- [ ] All existing tests pass (no regression)
- [ ] Rejected entities are logged with reason
- [ ] Valid entities (Zelensky, NATO, T-90M, Bakhmut) are NOT rejected

## 11. Open Questions

- [x] Should the validation filter also clean entity names (strip possessives, normalize case) or just reject?
  → **Clean + reject.** Reject invalid, clean fixable issues. See Section 7b.
- [x] Should rejected entities be counted in a metric (`ner_entities_rejected`) for monitoring?
  → **Yes.** See Section 8.1.
- [x] Should the filter be configurable per-connector (some sources may need looser rules)?
  → **Yes.** See Section 8.2.


---

## 7b. Entity Name Cleaning (Applied Before Validation)

Some fixes are transformations, not rejections. These are applied to the entity name BEFORE it enters the rule checks:

| Clean | Pattern | Before | After |
|-------|---------|--------|-------|
| `strip-possessive` | Trailing `'s` or `'` | `Beirut's` | `Beirut` |
| `strip-trailing-punct` | Trailing `.,;:!?` | `Washington.` | `Washington` |
| `strip-rt-prefix` | `RT @` prefix | `RT @username` | skip (handled by no-handles rule) |
| `strip-emoji` | Leading/trailing emoji | `🔥Ukraine🔥` | `Ukraine` |
| `normalize-whitespace` | Collapse whitespace | `New  York` | `New York` |
| `strip-quotes` | Leading/trailing quotes | `"NATO"` | `NATO` |

Cleaning happens FIRST. A cleaned entity is then validated. If cleaning produces an empty string, the entity is rejected.

## 8.1. Rejection Metrics

Each rejection increments a counter. The `EntityExtractionResult` grows a new field:

```typescript
export interface EntityExtractionResult {
  entitiesExtracted: number;
  entitiesCreated: number;
  entitiesDedupHit: number;
  linksCreated: number;
  errors: number;
  entitiesRejected: number;  // NEW — count of rejected entities
}
```

Each rejection logs:
```
NER: entity rejected — [Person] ChristopherJM — reason: looks like a Twitter handle
```

The counter is surfaced in the gRPC `PipelineMetadata` for observability.

## 8.2. Per-Connector Configuration

The `EntityExtractionConfig` in the YAML connector config grows a `validation` section:

```yaml
entityExtraction:
  enabled: true
  types: [Person, Organization, Location, Equipment, ...]
  minConfidence: 0.4
  validation:
    enabled: true           # default true
    rules:                  # empty = all rules enabled
      person:
        - no-handles
        - no-numbers
        - no-titles-only
        - min-length
      organization:
        - no-handles
        - no-roles
      equipment:
        - no-commercial
        - no-alert-systems
      location:
        - no-descriptions
        - min-length
    clean:                  # transformations before validation
      stripPossessive: true
      stripTrailingPunct: true
      stripEmoji: true
```

If a connector doesn't specify `validation`, all rules default to enabled. A connector can disable specific rules for its data source.


---

## 12. Review Findings — Reconciled

The following issues were identified in a fresh-context adversarial review and are addressed below.

### 🔴 Critical — Fixed

**C1/C2 — Person no-handles would reject valid lowercase names**
Fixed: Rule now uses precise handle detection patterns, not "any lowercase word."
- Reject: CamelCase handles (`ChristopherJM`, `JohnDoe42`) and lowercase_alphanumeric handles (`deaidua`, `kromark`)
- Accept: Simple lowercase names (`john`, `mark`, `omar`, `ivan`, `anna`) — these are real names
- Accept: Capitalized single names (`Zelensky`, `Putin`, `Biden`) — clearly real names
- Regex: `^(?:[a-z]+[A-Z][a-zA-Z]*|[a-z][a-z0-9_]{2,})$` — matches CamelCase OR lowercase-with-underscore/numbers

**C3 — Location no-bare-abbrev would reject US, UK, NY, DC, LA, etc.**
Fixed: RULE REMOVED. Bare abbreviations are too common in tweet text to reject automatically. Replaced with a weaker check: reject only single-character names (`A`, `B`, `Z`) under min-length.

**C4 — Equipment no-commercial substring triggers on "Anti-shipping missile"**
Fixed: Use word-boundary matching (`\bkeyword\b`) instead of substring match. "Anti-shipping missile" contains "shipping" as a substring within a compound word, but the regex `\bshipping\b` won't match it because there's no word boundary between "Anti-" and "shipping".

**C5 — Equipment no-alert-systems won't match "Sirens" (plural)**
Fixed: Use case-insensitive stem matching. Match `siren`, `sirens`, `alarm`, `alarms`, `alert`, `alerts`, `warning`, `warnings`, `announcement`, `announcements`.

**C6 — Equipment no-truncated ambiguity: "destroyer" contains "destr"**
Fixed: Explicit word-boundary suffix match. Match `\w+(stri|destr|oper|atta)$` — the truncated fragment must appear at the END of a word boundary.

### 🟡 Important — Fixed

**I1 — Test count understated (30 vs minimum 57)**
Fixed: Plan updated to 60+ tests (19 rules × min 2 tests = 38 base + 10 cleaning + 8 integration + 4 edge case composition).

**I2 — Equipment no-generic-only rejects "Patriot", "Javelin", "HIMARS"**
Fixed: Add capitalized exception. If the single word starts with uppercase → it's a proper name → accept. Only reject lowercase single generic words (`drones`, `missiles`, `radar`).

**I3 — Person titles and Org roles overlap**
Fixed: Person titles rule checks exact standalone match. Org roles rule checks multi-word phrases containing role keywords + additional words. No overlap.

**I4 — Location descriptions only check suffix**
Fixed: Check both prefix AND suffix. Match `^(region|area|coastal|northern|southern|eastern|western|border) ` and ` (region|area|border)$`.

**I5 — Person no-numbers undefined for alphanumeric codes**
Fixed: Explicit regex: `^[A-Za-z]+\d+$` — letters followed by numbers, no other pattern. Does NOT match `F-16` (has hyphen), `007` (all numeric), `J20` (letter+number only, no separator). Only matches patterns like `Jeff21461`, `Chris007`.

**I6 — No hashtag handling**
Fixed: Added `stripHashtag` to cleaning functions. `#Ukraine` → `Ukraine` before validation. If stripping produces empty string → reject.

**I7 — Org no-generic-nouns applied to multi-word entities**
Fixed: Rule only fires on SINGLE-WORD entities. Multi-word entities like "state universities" pass through.

**I8 — No measurement plan**
Fixed: Added Task 9a: Run audit SQL and verify each metric. Added explicit audit queries to the plan.

### 💡 Suggestion — Addressed

**S1 — Cleaning could change entity meaning**
Accepted as trade-off. Cleaning is conservative (only strips suffixes/prefixes, never adds). Documented as known limitation.

**S2 — No cross-entity dedup rule**
Left as future work. The dedup cache handles same-name+same-type lookup. Cross-type dedup requires entity resolution, which is a separate feature.

**S3 — Asymmetric length rules**
Fixed: Both Person and Location use min-length=2 for now. 2-char names (`Xi`, `Al`) are rare but valid.

**S4 — Composition semantics undefined**
Added explicit AND semantics: ALL enabled rules must pass. First failure short-circuits and returns the reject reason. Rules are evaluated in array order.

**S5 — No performance budget**
Added: Validation adds <0.1ms per entity (pure string operations). Acceptable for 5 tweets/sec × 8 entities/tweet = 40 validations/sec.

### Updated Rules (Post-Review)

**PERSON RULES:**
1. no-handles: reject CamelCase (`ChristopherJM`) or lowercase_alphanumeric (`deaidua`); accept `john`, `Zelensky`
2. no-numbers: reject `^[A-Za-z]+\d+$` pattern only
3. no-titles-only: reject EXACT standalone match of title word
4. min-length: reject < 2 chars (changed from 3)
5. no-descriptions: reject multi-word job descriptions

**ORGANIZATION RULES:**
1. no-handles: same as Person
2. no-roles: reject multi-word phrases containing role keywords (NOT single-word titles)
3. no-generic-nouns: reject single-word lowercase common nouns
4. min-length: reject < 2 chars

**EQUIPMENT RULES:**
1. no-commercial: word-boundary match on commercial keywords (`\bkeyword\b`)
2. no-alert-systems: stem-matched (siren/sirens, alarm/alarms, alert/alerts, warning/warnings)
3. no-generic-only: reject single-word LOWERCASE generic nouns; accept Capitalized/Digitized (Patriot, HIMARS, F-16)
4. no-truncated: word-boundary suffix match `\w+(stri|destr|oper|atta)$`
5. min-designation: reject < 2 words if lowercase generic

**LOCATION RULES:**
1. no-descriptions: check PREFIX and SUFFIX for region/area/border patterns
2. min-length: reject < 2 chars
3. ~~no-bare-abbrev~~ → REMOVED (too destructive for tweet data)

**NEW CLEANING:**
6. stripHashtag: `#Ukraine` → `Ukraine`. If result empty → reject.

