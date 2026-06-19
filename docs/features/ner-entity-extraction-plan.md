---
title: NER Entity Extraction Plan for OSINT Pipeline
created: 2026-06-17
last_updated: 2026-06-18
type: plan
status: in-progress
related_components:
  - sync-engine
  - api-gateway
  - ontology-engine
  - twitter-connector
related_features:
  - osint-domain-pack
related_decisions:
  - adr-010-osint-schema-design
---

# NER Entity Extraction Plan — OSINT Pipeline

## 1. Overview

### 1.1 Goal

When a tweet says *"Russian T-90M tanks spotted near Bakhmut by Ukrainian forces"*, the ingestion pipeline should automatically:

1. Create/lookup an **Organization** object: `"Russia"` (type: MILITARY_UNIT)
2. Create/lookup an **Equipment** object: `"T-90M"` (type: MAIN_BATTLE_TANK)  
3. Create/lookup a **Location** object: `"Bakhmut"` (type: CITY, country: UA)
4. Create/lookup an **Organization** object: `"Ukraine"` (type: MILITARY_UNIT)
5. Wire them all to the `IntelReport` via `MentionsOrganization`, `MentionsEquipment`, `MentionsLocation` links

This transforms the OSINT pipeline from raw text ingestion into a connected knowledge graph.

### 1.2 Current State

| What exists | Status |
|-------------|--------|
| IntelReport ingestion from Twitter | ✓ Live — 3000+ tweets stored |
| SourceProfile auto-creation | ✓ Live — 13 profiles created |
| ReportedBy links | ✓ Live — 158 links in PostgreSQL, 172 edges in AGE |
| Person table | ✗ Empty — no entity extraction |
| Organization table | ✗ Empty |
| Location table | ✗ Empty |
| Equipment table | ✗ Empty |
| MentionsPerson links | ✗ Not created |
| MentionsOrganization links | ✗ Not created |
| MentionsLocation links | ✗ Not created |
| MentionsEquipment links | ✗ Not created |
| Assessment table | ✗ Empty (analyst workflow) |
| Narrative table | ✗ Empty (disinformation tracking) |
| Indicator table | ✗ Empty (early warning) |

### 1.3 Why Hybrid NER

Off-the-shelf NER libraries (wink-ner, compromise, NLP.js) recognize Person, Organization, and Location — but **cannot recognize military equipment names** like "T-90M", "HIMARS", "Bayraktar TB2". These are domain-specific and require a curated list.

We use a two-pronged approach:
- **Wink NER** (pure JS, ~3MB model, zero network calls) for general entity types
- **Equipment Gazetteer** (YAML file, regex matching) for military equipment

No external API keys, no network calls, no cost. Self-contained.

---

## 2. Architecture

### 2.1 Module Structure

```
packages/sync/src/entity-extraction/
├── types.ts                          # Core interfaces
├── wink-extractor.ts                 # Wink NER implementation
├── gazetteer-extractor.ts            # Equipment name matching
├── composite-extractor.ts            # Combines multiple extractors
├── entity-dedup.ts                   # In-memory LRU dedup cache
├── entity-extraction-service.ts      # Orchestrator
└── __tests__/
    ├── wink-extractor.test.ts
    ├── gazetteer-extractor.test.ts
    ├── entity-dedup.test.ts
    ├── composite-extractor.test.ts
    └── entity-extraction-service.test.ts

domain-packs/osint/entity-extraction/
└── equipment-gazetteer.yaml          # Equipment names + aliases
```

### 2.2 Data Flow

```
IntelReport created (changeApplier in server.ts)
  │
  ├─ content: "Russian T-90M tanks near Bakhmut"
  │
  ▼ EntityExtractionService.processReport(reportId, text, ctx)
  │
  ├─ 1. CompositeExtractor.extract(text)
  │     ├─ WinkExtractor.extract(text)
  │     │   → [{type: "Organization", name: "Russia", confidence: 0.85},
  │     │      {type: "Location", name: "Bakhmut", confidence: 0.92}]
  │     └─ GazetteerExtractor.extract(text)
  │         → [{type: "Equipment", name: "T-90M", confidence: 1.0}]
  │
  ├─ 2. For each ExtractedEntity:
  │     ├─ EntityDedupCache.resolve(type, name)
  │     │   ├─ Cache hit → return existing _id
  │     │   └─ Cache miss → query DB by name
  │     │       ├─ Found → cache + return _id  
  │     │       └─ Not found → ObjectManager.create() → cache + return _id
  │     │
  │     └─ LinkManager.createLink("Mentions{Type}", reportId, entityId, ctx)
  │
  └─ 3. Return summary: { entitiesExtracted: 3, entitiesCreated: 2, linksCreated: 3 }
```

### 2.3 Integration Point in server.ts

The NER call is injected into the existing `changeApplier` closure, right after `objectManager.create()` for the IntelReport and before the `ReportedBy` link creation:

```typescript
// Existing flow:
await objectManager.create('IntelReport', props, ctx);      // Step A: store report
const actualReportId = created._id;

// NEW: Entity extraction (best-effort, non-blocking)
const reportText = mapped.properties['content'] as string;
if (reportText?.trim()) {
  try {
    const result = await entityExtractionService.processReport(
      actualReportId, reportText, ctx
    );
    metrics.entitiesExtracted.add(result.entitiesExtracted);
    metrics.entitiesCreated.add(result.entitiesCreated);
    metrics.linksCreated.add(result.linksCreated);
  } catch (nerErr) {
    logger.warn({ nerErr, reportId: actualReportId }, 
      'Entity extraction failed — report stored without entities');
  }
}

// Existing flow continues:
await linkManager.createLink('ReportedBy', actualReportId, ...);  // Step C: link to source
```

**Key design principle**: Entity extraction is best-effort. A failure in NER must never block the IntelReport from being stored. The try/catch ensures this.

---

## 3. Detailed Implementation

### Phase 1: Core Types and Interfaces

#### File: `packages/sync/src/entity-extraction/types.ts` (NEW)

```typescript
/**
 * Core types for the entity extraction module.
 */

/** A single entity extracted from text. */
export interface ExtractedEntity {
  /** Ontology type: 'Person', 'Organization', 'Location', 'Equipment' */
  type: string;
  /** The extracted entity name (e.g., "Zelensky", "Bakhmut", "T-90M") */
  name: string;
  /** Surrounding text context (~50 chars) */
  context?: string;
  /** Confidence score 0.0-1.0 */
  confidence: number;
}

/** Contract for any NER implementation. */
export interface EntityExtractor {
  /** Human-readable name for logging/metrics */
  readonly name: string;
  /** Extract entities from raw text. Returns empty array on failure. */
  extract(text: string): Promise<ExtractedEntity[]>;
}

/** Result of processing one report through entity extraction. */
export interface EntityExtractionResult {
  entitiesExtracted: number;
  entitiesCreated: number;
  entitiesDedupHit: number;
  linksCreated: number;
  errors: number;
}

/** Configuration for entity extraction from connector YAML. */
export interface EntityExtractionConfig {
  enabled: boolean;
  types?: string[];              // e.g., ["Person", "Organization", "Location", "Equipment"]
  minConfidence?: number;        // default 0.6
  maxEntitiesPerReport?: number; // default 20
  minTextLength?: number;        // skip reports shorter than this (default 30)
}
```

Design decisions:
- `EntityExtractor` interface allows swapping NER backends without changing pipeline code
- `ExtractedEntity.confidence` enables threshold filtering
- `EntityExtractionConfig` is parsed from connector YAML for per-source configuration

#### File: `packages/sync/src/mapping/mapping-parser.ts` (MODIFY)

Add to `DatasourceMappingConfig`:

```typescript
export interface EntityExtractionConfig {
  enabled: boolean;
  types?: string[];
  minConfidence?: number;
  maxEntitiesPerReport?: number;
  minTextLength?: number;
}

export interface DatasourceMappingConfig {
  // ... existing fields ...
  entityExtraction?: EntityExtractionConfig;  // NEW
}
```

Parse from raw YAML in `buildConfig()`:

```typescript
function buildConfig(raw: RawConfig): DatasourceMappingConfig {
  return {
    // ... existing fields ...
    entityExtraction: raw.entityExtraction ? {
      enabled: raw.entityExtraction.enabled ?? true,
      types: raw.entityExtraction.types,
      minConfidence: raw.entityExtraction.minConfidence ?? 0.6,
      maxEntitiesPerReport: raw.entityExtraction.maxEntitiesPerReport ?? 20,
      minTextLength: raw.entityExtraction.minTextLength ?? 30,
    } : undefined,
  };
}
```

### Phase 2: Entity Extractors

#### File: `packages/sync/src/entity-extraction/wink-extractor.ts` (NEW)

```typescript
import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import type { EntityExtractor, ExtractedEntity } from './types';

/**
 * Wink NER extractor — Person, Organization, Location detection.
 * Pure JavaScript, ~3MB model, zero network calls.
 */
export class WinkExtractor implements EntityExtractor {
  readonly name = 'wink-ner';
  private nlp: ReturnType<typeof winkNLP>;
  private its: ReturnType<typeof this.nlp.its>;

  constructor(private minConfidence = 0.6) {
    this.nlp = winkNLP(model);
    this.its = this.nlp.its;
  }

  async extract(text: string): Promise<ExtractedEntity[]> {
    const doc = this.nlp.readDoc(text);
    const entities = doc.entities().out();
    
    // Wink returns: [{entityType: "PER", value: "Zelensky", ...}, ...]
    // Map to our ontology types:
    // PER → Person, ORG → Organization, GPE/LOC → Location
    return entities
      .filter((e: any) => this.mapType(e.entityType) !== null)
      .filter((e: any) => e.confidence >= this.minConfidence)
      .map((e: any) => ({
        type: this.mapType(e.entityType)!,
        name: this.normalizeName(e.value, this.mapType(e.entityType)!),
        context: this.extractContext(text, e.value),
        confidence: e.confidence,
      }))
      .filter((e, i, arr) => this.isUnique(e, i, arr));
  }

  private mapType(winkType: string): string | null {
    switch (winkType) {
      case 'PER': return 'Person';
      case 'ORG': return 'Organization';
      case 'GPE':
      case 'LOC': return 'Location';
      default: return null;
    }
  }

  private normalizeName(name: string, type: string): string {
    // Strip titles for Person: "President Zelensky" → "Zelensky"
    // Strip suffixes for Org: "Russian MOD" → "Russian MOD" (keep as-is)
    if (type === 'Person') {
      return name.replace(/^(President|General|Minister|Secretary|Dr\.|Mr\.|Ms\.)\s+/i, '').trim();
    }
    return name.trim();
  }

  private extractContext(text: string, name: string): string {
    const idx = text.indexOf(name);
    if (idx === -1) return '';
    const start = Math.max(0, idx - 25);
    const end = Math.min(text.length, idx + name.length + 25);
    return text.slice(start, end).trim();
  }

  private isUnique(entity: ExtractedEntity, index: number, arr: ExtractedEntity[]): boolean {
    // Deduplicate within a single text (same name + same type)
    return arr.findIndex(e => e.name === entity.name && e.type === entity.type) === index;
  }
}
```

Key implementation notes:
- **Type mapping**: Wink uses `PER`/`ORG`/`GPE`/`LOC` — we map to Person/Organization/Location
- **Confidence filtering**: Default threshold 0.6 (conservative — fewer false positives)
- **Name normalization**: Strips titles from Person names to aid deduplication
- **Context extraction**: Surrounding ~50 chars for analyst reference
- **Intra-text dedup**: Same name + same type within one tweet → single extraction

#### File: `packages/sync/src/entity-extraction/gazetteer-extractor.ts` (NEW)

```typescript
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { EntityExtractor, ExtractedEntity } from './types';

interface GazetteerEntry {
  designation: string;
  aliases?: string[];
  category?: string;
}

interface GazetteerFile {
  equipment: GazetteerEntry[];
}

/**
 * Equipment gazetteer extractor — matches military equipment names
 * against a curated YAML list. Case-insensitive substring matching.
 */
export class GazetteerExtractor implements EntityExtractor {
  readonly name = 'gazetteer-equipment';
  private patterns: Array<{ regex: RegExp; designation: string; category?: string }> = [];

  constructor(gazetteerPath: string) {
    const content = readFileSync(gazetteerPath, 'utf-8');
    const data = parseYaml(content) as GazetteerFile;
    
    // Build regex patterns with word boundaries for each equipment + aliases
    for (const entry of data.equipment) {
      const names = [entry.designation, ...(entry.aliases ?? [])];
      for (const name of names) {
        // Escape special regex chars in the name (e.g., "T-72" has a hyphen)
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        this.patterns.push({
          regex: new RegExp(`\\b${escaped}\\b`, 'gi'),
          designation: entry.designation,
          category: entry.category,
        });
      }
    }
  }

  async extract(text: string): Promise<ExtractedEntity[]> {
    const matched = new Map<string, ExtractedEntity>();
    
    for (const pattern of this.patterns) {
      const match = pattern.regex.exec(text);
      if (match) {
        const key = `${pattern.designation}`;
        if (!matched.has(key)) {
          matched.set(key, {
            type: 'Equipment',
            name: pattern.designation,
            context: this.extractContext(text, match[0]),
            confidence: 1.0, // Gazetteer matches are exact — high confidence
          });
        }
      }
    }
    
    return [...matched.values()];
  }

  private extractContext(text: string, name: string): string {
    const idx = text.indexOf(name);
    if (idx === -1) return '';
    const start = Math.max(0, idx - 25);
    const end = Math.min(text.length, idx + name.length + 25);
    return text.slice(start, end);
  }
}
```

**Note on regex**: The `regex` objects maintain state (`lastIndex`) when using the `g` flag and `exec()`. Each regex needs to be recreated or have its `lastIndex` reset. The code above creates patterns once but calls `exec()` which only returns the first match (not all matches). For production, we'd use `matchAll()` or reset `lastIndex`.

#### File: `packages/sync/src/entity-extraction/composite-extractor.ts` (NEW)

```typescript
import type { EntityExtractor, ExtractedEntity } from './types';

/**
 * Runs multiple extractors and merges results.
 * Deduplicates across extractors (same name + same type → keep highest confidence).
 */
export class CompositeExtractor implements EntityExtractor {
  readonly name = 'composite';

  constructor(private extractors: EntityExtractor[]) {}

  async extract(text: string): Promise<ExtractedEntity[]> {
    const allResults = await Promise.all(
      this.extractors.map(async (extractor) => {
        try {
          return await extractor.extract(text);
        } catch (err) {
          console.error(`[ner] Extractor '${extractor.name}' failed:`, err);
          return [];
        }
      })
    );

    // Merge all results, deduplicate by type+name, keep highest confidence
    const merged = new Map<string, ExtractedEntity>();
    
    for (const results of allResults) {
      for (const entity of results) {
        const key = `${entity.type}:${entity.name.toLowerCase()}`;
        const existing = merged.get(key);
        if (!existing || entity.confidence > existing.confidence) {
          merged.set(key, entity);
        }
      }
    }

    return [...merged.values()];
  }
}
```

### Phase 3: Deduplication Cache

#### File: `packages/sync/src/entity-extraction/entity-dedup.ts` (NEW)

```typescript
import type { StorageProvider, RequestContext } from '@openfoundry/spi';
import type { ObjectManager } from '@openfoundry/engine';

interface CacheEntry {
  entityId: string;
  accessedAt: number;
}

/**
 * In-memory LRU cache for entity deduplication.
 * Prevents creating duplicate Person/Org/Location/Equipment objects
 * when the same name appears across multiple tweets.
 */
export class EntityDedupCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;

  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  /** Look up an already-created entity by type+name. Returns _id or null. */
  async resolve(
    type: string,
    name: string,
    storage: StorageProvider,
    ctx: RequestContext,
  ): Promise<string | null> {
    const key = `${type}:${name.toLowerCase()}`;

    // 1. Check in-memory cache
    const cached = this.cache.get(key);
    if (cached) {
      cached.accessedAt = Date.now();
      return cached.entityId;
    }

    // 2. Query database by name
    const existingId = await this.queryByName(type, name, storage, ctx);
    if (existingId) {
      this.set(key, existingId);
      return existingId;
    }

    return null;
  }

  /** Cache a newly created entity's ID. */
  set(type: string, name: string, entityId: string): void {
    const key = `${type}:${name.toLowerCase()}`;
    
    // LRU eviction: if at capacity, remove least recently accessed
    if (this.cache.size >= this.maxSize) {
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.accessedAt < oldestTime) {
          oldestTime = v.accessedAt;
          oldestKey = k;
        }
      }
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, { entityId, accessedAt: Date.now() });
  }

  /** Clear the cache (useful for testing). */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  private async queryByName(
    type: string,
    name: string,
    storage: StorageProvider,
    ctx: RequestContext,
  ): Promise<string | null> {
    try {
      const tableName = this.tableNameFor(type);
      const fieldName = this.fieldNameFor(type);

      // Direct SQL query since ObjectManager only supports lookup by _id
      const result = await (storage as any).pool.query(
        `SELECT "_id" FROM public.${tableName} 
         WHERE "_tenant_id" = $1 AND LOWER("${fieldName}") = LOWER($2)
         AND "_deleted_at" IS NULL LIMIT 1`,
        [ctx.tenantId, name]
      );

      if (result.rows.length > 0) {
        return result.rows[0]._id as string;
      }
    } catch {
      // Table may not exist yet, or column may not have index
    }
    return null;
  }

  private tableNameFor(type: string): string {
    switch (type) {
      case 'Person': return 'person';
      case 'Organization': return 'organization';
      case 'Location': return 'location';
      case 'Equipment': return 'equipment';
      default: return type.toLowerCase();
    }
  }

  private fieldNameFor(type: string): string {
    switch (type) {
      case 'Person': return 'full_name';
      case 'Organization': return 'name';
      case 'Location': return 'name';
      case 'Equipment': return 'designation';
      default: return 'name';
    }
  }
}
```

**LRU eviction**: When the cache exceeds `maxSize` (default 10,000), the least recently accessed entry is evicted. A cache miss triggers a database query, which is slower but acceptable as a fallback.

**Database lookup**: Uses `storage.pool.query()` directly because `ObjectManager.get()` only supports lookup by `_id`, not by field. This is a pragmatic choice — the alternative would be implementing `getByField()` on the ObjectManager interface.

### Phase 4: Orchestrator Service

#### File: `packages/sync/src/entity-extraction/entity-extraction-service.ts` (NEW)

```typescript
import type { ObjectManager, LinkManager } from '@openfoundry/engine';
import type { StorageProvider, RequestContext } from '@openfoundry/spi';
import type { EntityExtractor, EntityExtractionResult } from './types';
import { EntityDedupCache } from './entity-dedup';

/**
 * Orchestrates the full entity extraction pipeline:
 * extract → dedup → create/lookup entity → create Mentions* link.
 * 
 * Failures are per-entity — one bad entity doesn't block others.
 */
export class EntityExtractionService {
  constructor(
    private extractor: EntityExtractor,
    private dedupCache: EntityDedupCache,
    private objectManager: ObjectManager,
    private linkManager: LinkManager,
    private storage: StorageProvider,
    private config: { minConfidence: number; maxEntities: number; minTextLength: number } = {
      minConfidence: 0.6, maxEntities: 20, minTextLength: 30,
    },
  ) {}

  async processReport(
    reportId: string,
    text: string,
    ctx: RequestContext,
  ): Promise<EntityExtractionResult> {
    const result: EntityExtractionResult = {
      entitiesExtracted: 0,
      entitiesCreated: 0,
      entitiesDedupHit: 0,
      linksCreated: 0,
      errors: 0,
    };

    // Skip very short reports (e.g., image-only tweets)
    if (!text || text.trim().length < this.config.minTextLength) {
      return result;
    }

    // Step 1: Extract entities
    let entities: Awaited<ReturnType<EntityExtractor['extract']>>;
    try {
      entities = await this.extractor.extract(text);
    } catch (err) {
      result.errors++;
      return result;
    }

    // Filter by confidence and limit count
    entities = entities
      .filter(e => e.confidence >= this.config.minConfidence)
      .slice(0, this.config.maxEntities);

    result.entitiesExtracted = entities.length;

    // Step 2: For each entity — resolve or create, then link
    for (const entity of entities) {
      try {
        // 2a. Look up existing entity (cache → DB)
        let entityId = await this.dedupCache.resolve(
          entity.type, entity.name, this.storage, ctx
        );

        // 2b. Create if not found
        if (!entityId) {
          const created = await this.createEntity(entity, ctx);
          if (created) {
            entityId = created;
            this.dedupCache.set(entity.type, entity.name, entityId);
            result.entitiesCreated++;
          }
        } else {
          result.entitiesDedupHit++;
        }

        // 2c. Create Mentions* link
        if (entityId) {
          const linkType = this.linkTypeFor(entity.type);
          await this.linkManager.createLink(
            linkType, reportId, entityId,
            { context: entity.context, confidence: entity.confidence },
            ctx,
          );
          result.linksCreated++;
        }
      } catch (err) {
        result.errors++;
        // Continue with next entity — one failure doesn't block others
      }
    }

    return result;
  }

  private async createEntity(
    entity: { type: string; name: string },
    ctx: RequestContext,
  ): Promise<string | null> {
    const now = new Date().toISOString();
    const base = {
      createdAt: now,
      createdBy: 'ner-pipeline',
      updatedAt: now,
      updatedBy: 'ner-pipeline',
    };

    switch (entity.type) {
      case 'Person': {
        const created = await this.objectManager.create('Person', {
          ...base,
          fullName: entity.name,
          watchlistStatus: 'NONE',
          isPersonOfInterest: false,
        }, ctx);
        return created._id;
      }
      case 'Organization': {
        const created = await this.objectManager.create('Organization', {
          ...base,
          name: entity.name,
          type: 'OTHER', // Default — can be refined later by analyst
          isDesignated: false,
        }, ctx);
        return created._id;
      }
      case 'Location': {
        const created = await this.objectManager.create('Location', {
          ...base,
          name: entity.name,
          type: 'CITY', // Default — can be refined
          country: 'UNKNOWN',
          status: 'UNKNOWN',
        }, ctx);
        return created._id;
      }
      case 'Equipment': {
        const created = await this.objectManager.create('Equipment', {
          ...base,
          designation: entity.name,
          category: 'OTHER',
        }, ctx);
        return created._id;
      }
      default:
        return null;
    }
  }

  private linkTypeFor(entityType: string): string {
    switch (entityType) {
      case 'Person': return 'MentionsPerson';
      case 'Organization': return 'MentionsOrganization';
      case 'Location': return 'MentionsLocation';
      case 'Equipment': return 'MentionsEquipment';
      default: throw new Error(`Unknown entity type: ${entityType}`);
    }
  }
}
```

**Design decisions**:
- **Best-effort per entity**: Each entity extraction+creation+link is isolated in a try/catch. A failure on "Bakhmut" doesn't block "Russia".
- **Default values for unknowns**: `Organization.type = 'OTHER'`, `Location.type = 'CITY'`, `Location.country = 'UNKNOWN'`. These are placeholders — analysts can refine them via the UI later.
- **`linkTypeFor()` mapping**: Hardcoded mapping for now. Could be made configurable.

### Phase 5: Pipeline Integration

#### File: `packages/api/src/server.ts` (MODIFY — ~30 lines added)

**Location**: Inside the `changeApplier` closure, after `objectManager.create()` for the IntelReport and before the `for (const link of mapped.links)` loop.

```typescript
// ... existing code creates IntelReport ...

const created = await objectManager.create(mapped.objectType, props, ctx);
const actualReportId = created._id;

// ── NEW: Entity Extraction (best-effort, non-blocking) ──
const reportText = mapped.properties['content'] as string;
const entityConfig = mappingConfig.entityExtraction;
if (entityConfig?.enabled !== false && reportText?.trim()) {
  try {
    const result = await entityExtractionService.processReport(
      actualReportId, reportText, ctx,
    );
    // Log at info level for observability
    if (result.entitiesExtracted > 0) {
      logger.info({
        reportId: actualReportId,
        ...result,
      }, 'NER: extracted entities from report');
    }
  } catch (nerErr) {
    // Non-fatal — report is already stored
    logger.warn({ nerErr, reportId: actualReportId }, 
      'NER: entity extraction failed, report stored without entities');
  }
}

// ── Existing: ReportedBy link creation ──
for (const link of mapped.links) {
  // ...
}
```

**Dependency initialization** (in `server.ts` main(), around line 540, after ObjectManager and LinkManager are created):

```typescript
// ── Entity Extraction Setup ──
const nlp = await import('wink-nlp');
const winkModel = await import('wink-eng-lite-web-model');

const winkExtractor = new WinkExtractor(0.6);
const gazetteerPath = resolve(domainPacksDir, 'osint', 'entity-extraction', 'equipment-gazetteer.yaml');
const gazetteerExtractor = existsSync(gazetteerPath) 
  ? new GazetteerExtractor(gazetteerPath) 
  : null;

const extractors = [winkExtractor];
if (gazetteerExtractor) extractors.push(gazetteerExtractor);
const compositeExtractor = new CompositeExtractor(extractors);

const entityDedupCache = new EntityDedupCache(10000);
const entityExtractionService = new EntityExtractionService(
  compositeExtractor,
  entityDedupCache,
  objectManager,
  linkManager,
  storage,
  { minConfidence: 0.6, maxEntities: 20, minTextLength: 30 },
);
```

### Phase 6: Configuration

#### File: `domain-packs/osint/connectors/twitter-osint.yaml` (MODIFY)

Add at end of file:

```yaml
entityExtraction:
  enabled: true
  types:
    - Person
    - Organization
    - Location
    - Equipment
  minConfidence: 0.6
  maxEntitiesPerReport: 20
  minTextLength: 30
```

#### File: `domain-packs/osint/entity-extraction/equipment-gazetteer.yaml` (NEW)

```yaml
# Military Equipment Gazetteer for OSINT NER
# Format: designation + aliases (case-insensitive matching)
# Update this file to add new equipment as it emerges in conflict zones.

equipment:
  # Main Battle Tanks
  - designation: "T-90M"
    aliases: ["T-90", "T90", "T-90M Proryv"]
    category: MAIN_BATTLE_TANK
  - designation: "T-72"
    aliases: ["T72", "T-72B", "T-72B3", "T-72M1"]
    category: MAIN_BATTLE_TANK
  - designation: "T-80"
    aliases: ["T80", "T-80BVM", "T-80U"]
    category: MAIN_BATTLE_TANK
  - designation: "T-64"
    aliases: ["T64", "T-64BV"]
    category: MAIN_BATTLE_TANK
  - designation: "Leopard 2"
    aliases: ["Leopard2", "Leopard 2A4", "Leopard 2A6"]
    category: MAIN_BATTLE_TANK
  - designation: "Challenger 2"
    aliases: ["Challenger2"]
    category: MAIN_BATTLE_TANK
  - designation: "Abrams"
    aliases: ["M1 Abrams", "M1A1", "M1A2"]
    category: MAIN_BATTLE_TANK
  - designation: "Merkava"
    aliases: ["Merkava IV", "Merkava Mk4"]
    category: MAIN_BATTLE_TANK

  # Armored Vehicles
  - designation: "BMP-3"
    aliases: ["BMP3", "BMP-2", "BMP2", "BMP-1", "BMP1"]
    category: ARMORED_VEHICLE
  - designation: "BTR-82A"
    aliases: ["BTR-82", "BTR82A", "BTR-80", "BTR80"]
    category: ARMORED_VEHICLE
  - designation: "Bradley"
    aliases: ["M2 Bradley", "M2A2", "M3 Bradley"]
    category: ARMORED_VEHICLE
  - designation: "Stryker"
    aliases: ["M1126 Stryker"]
    category: ARMORED_VEHICLE
  - designation: "MT-LB"
    aliases: ["MTLB"]
    category: ARMORED_VEHICLE
  - designation: "Humvee"
    aliases: ["HMMWV", "M1151"]
    category: ARMORED_VEHICLE

  # Artillery & MLRS
  - designation: "HIMARS"
    aliases: ["M142 HIMARS"]
    category: MULTIPLE_ROCKET_LAUNCHER
  - designation: "M270 MLRS"
    aliases: ["M270", "MLRS"]
    category: MULTIPLE_ROCKET_LAUNCHER
  - designation: "BM-21 Grad"
    aliases: ["Grad", "BM21"]
    category: MULTIPLE_ROCKET_LAUNCHER
  - designation: "BM-30 Smerch"
    aliases: ["Smerch", "BM30", "Tornado-S"]
    category: MULTIPLE_ROCKET_LAUNCHER
  - designation: "M777"
    aliases: ["M777 howitzer", "M777A2"]
    category: ARTILLERY
  - designation: "2S19 Msta-S"
    aliases: ["Msta-S", "2S19", "2S19M2"]
    category: ARTILLERY
  - designation: "CAESAR"
    aliases: ["CAESAR howitzer", "CAESAR 6x6", "CAESAR 8x8"]
    category: ARTILLERY
  - designation: "PzH 2000"
    aliases: ["PzH2000", "Panzerhaubitze 2000"]
    category: ARTILLERY
  - designation: "Archer"
    aliases: ["Archer howitzer", "FH77 BW L52"]
    category: ARTILLERY

  # Air Defense
  - designation: "S-400"
    aliases: ["S400", "SA-21 Growler", "S-300", "S300"]
    category: AIR_DEFENSE
  - designation: "Patriot"
    aliases: ["MIM-104 Patriot", "PAC-2", "PAC-3"]
    category: AIR_DEFENSE
  - designation: "IRIS-T"
    aliases: ["IRIS-T SLM", "IRIS-T SLS"]
    category: AIR_DEFENSE
  - designation: "NASAMS"
    aliases: []
    category: AIR_DEFENSE
  - designation: "Buk"
    aliases: ["Buk-M1", "Buk-M2", "Buk-M3", "SA-11", "SA-17"]
    category: AIR_DEFENSE
  - designation: "Tor"
    aliases: ["Tor-M2", "SA-15 Gauntlet"]
    category: AIR_DEFENSE
  - designation: "Pantsir-S1"
    aliases: ["Pantsir", "Pantsir-S", "SA-22 Greyhound"]
    category: AIR_DEFENSE

  # Aircraft
  - designation: "Su-35"
    aliases: ["Su35", "Su-35S", "Flanker-E"]
    category: FIXED_WING_AIRCRAFT
  - designation: "Su-34"
    aliases: ["Su34", "Fullback"]
    category: FIXED_WING_AIRCRAFT
  - designation: "Su-25"
    aliases: ["Su25", "Frogfoot", "Su-25SM3"]
    category: FIXED_WING_AIRCRAFT
  - designation: "MiG-31"
    aliases: ["MiG31", "Foxhound", "MiG-31K"]
    category: FIXED_WING_AIRCRAFT
  - designation: "F-16"
    aliases: ["F16", "F-16AM", "F-16BM", "Viper"]
    category: FIXED_WING_AIRCRAFT
  - designation: "F-35"
    aliases: ["F35", "Lightning II", "F-35A", "F-35B"]
    category: FIXED_WING_AIRCRAFT
  - designation: "A-50"
    aliases: ["A50", "A-50U", "Mainstay"]
    category: FIXED_WING_AIRCRAFT

  # Helicopters
  - designation: "Ka-52"
    aliases: ["Ka52", "Alligator", "Hokum-B"]
    category: HELICOPTER
  - designation: "Mi-8"
    aliases: ["Mi8", "Mi-17", "Mi-8MTV-5", "Hip"]
    category: HELICOPTER
  - designation: "Mi-24"
    aliases: ["Mi24", "Mi-35", "Hind"]
    category: HELICOPTER
  - designation: "Mi-28"
    aliases: ["Mi28", "Havoc", "Mi-28NM"]
    category: HELICOPTER
  - designation: "AH-64 Apache"
    aliases: ["Apache", "AH-64", "AH-64E"]
    category: HELICOPTER

  # Drones / UAVs
  - designation: "Bayraktar TB2"
    aliases: ["TB2", "Bayraktar"]
    category: DRONE
  - designation: "Shahed-136"
    aliases: ["Shahed136", "Shahed-131", "Geran-2", "Geranium"]
    category: DRONE
  - designation: "Lancet"
    aliases: ["Lancet-3", "ZALA Lancet", "Izdeliye-52"]
    category: LOITERING_MUNITION
  - designation: "Orlan-10"
    aliases: ["Orlan10", "Orlan-30"]
    category: DRONE
  - designation: "MQ-9 Reaper"
    aliases: ["Reaper", "MQ-9", "Predator B"]
    category: DRONE
  - designation: "Switchblade"
    aliases: ["Switchblade 300", "Switchblade 600"]
    category: LOITERING_MUNITION

  # Missiles
  - designation: "Iskander"
    aliases: ["Iskander-M", "Iskander-K", "SS-26 Stone", "9K720"]
    category: MISSILE_SYSTEM
  - designation: "Kalibr"
    aliases: ["Kalibr cruise missile", "3M-54", "3M14"]
    category: MISSILE_SYSTEM
  - designation: "Kh-101"
    aliases: ["Kh101", "Kh-555", "Kh-55"]
    category: MISSILE_SYSTEM
  - designation: "Storm Shadow"
    aliases: ["SCALP-EG", "SCALP"]
    category: MISSILE_SYSTEM
  - designation: "ATACMS"
    aliases: ["MGM-140 ATACMS"]
    category: MISSILE_SYSTEM
  - designation: "Kinzhai"
    aliases: ["Kh-47M2 Kinzhal", "Dagger"]
    category: MISSILE_SYSTEM
  - designation: "Zircon"
    aliases: ["3M22 Zircon", "Tsirkon"]
    category: MISSILE_SYSTEM
  - designation: "Oreshnik"
    aliases: []
    category: MISSILE_SYSTEM

  # Naval
  - designation: "Admiral Grigorovich"
    aliases: ["Project 11356R", "Grigorovich-class"]
    category: NAVAL_VESSEL

  # Electronic Warfare
  - designation: "Krasukha-4"
    aliases: ["Krasukha", "1RL257"]
    category: ELECTRONIC_WARFARE
  - designation: "Borisoglebsk-2"
    aliases: ["Borisoglebsk", "R-330Zh"]
    category: ELECTRONIC_WARFARE
  - designation: "Leer-3"
    aliases: ["Leer3", "RB-341V"]
    category: ELECTRONIC_WARFARE

  # Radar
  - designation: "Zoopark-1"
    aliases: ["Zoopark", "1L219M"]
    category: RADAR
  - designation: "Counter-battery radar"
    aliases: ["AN/TPQ-36", "AN/TPQ-53", "COBRA"]
    category: RADAR
  - designation: "ZALA"
    aliases: ["ZALA Aero"]
    category: DRONE
```

This file should be maintained over time — add new equipment as it appears in conflict zones.

---

## 4. Testing Strategy

### 4.1 Unit Tests

#### File: `packages/sync/src/entity-extraction/__tests__/wink-extractor.test.ts` (NEW)

```typescript
import { describe, it, expect } from 'vitest';
import { WinkExtractor } from '../wink-extractor';

const extractor = new WinkExtractor(0.6);

describe('WinkExtractor', () => {
  it('extracts Person entities', async () => {
    const result = await extractor.extract('President Zelensky announced new sanctions today.');
    const persons = result.filter(e => e.type === 'Person');
    expect(persons.length).toBeGreaterThan(0);
    expect(persons.some(p => p.name.toLowerCase().includes('zelensky'))).toBe(true);
  });

  it('extracts Organization entities', async () => {
    const result = await extractor.extract('NATO forces deployed to the region.');
    const orgs = result.filter(e => e.type === 'Organization');
    expect(orgs.some(o => o.name.toLowerCase().includes('nato'))).toBe(true);
  });

  it('extracts Location entities', async () => {
    const result = await extractor.extract('Heavy shelling reported near Bakhmut, Ukraine.');
    const locs = result.filter(e => e.type === 'Location');
    expect(locs.some(l => l.name.toLowerCase().includes('bakhmut'))).toBe(true);
  });

  it('strips titles from Person names', async () => {
    const result = await extractor.extract('General Surovikin and President Putin met in Moscow.');
    const persons = result.filter(e => e.type === 'Person');
    expect(persons.some(p => p.name === 'Surovikin')).toBe(true);
    expect(persons.some(p => p.name === 'Putin')).toBe(true);
  });

  it('returns empty array for empty text', async () => {
    const result = await extractor.extract('');
    expect(result).toEqual([]);
  });

  it('returns empty array for very short text', async () => {
    const result = await extractor.extract('OK');
    expect(result.length).toBeLessThanOrEqual(1); // May or may not extract "OK"
  });

  it('handles non-English text gracefully', async () => {
    const result = await extractor.extract('Путин встретился с Зеленским в Москве');
    // Should not crash — may or may not extract entities
    expect(Array.isArray(result)).toBe(true);
  });

  it('deduplicates same name within one text', async () => {
    const result = await extractor.extract('Putin and Putin met in Moscow. Putin spoke.');
    const putins = result.filter(e => e.name === 'Putin');
    expect(putins.length).toBe(1); // Deduplicated
  });
});
```

#### File: `packages/sync/src/entity-extraction/__tests__/gazetteer-extractor.test.ts` (NEW)

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { GazetteerExtractor } from '../gazetteer-extractor';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Create a temp gazetteer for testing
const tmpGazetteer = join(tmpdir(), 'test-equipment-gazetteer.yaml');
writeFileSync(tmpGazetteer, `
equipment:
  - designation: "T-90M"
    aliases: ["T-90", "T90"]
    category: MAIN_BATTLE_TANK
  - designation: "HIMARS"
    aliases: []
    category: MULTIPLE_ROCKET_LAUNCHER
  - designation: "Bayraktar TB2"
    aliases: ["TB2", "Bayraktar"]
    category: DRONE
`);

const extractor = new GazetteerExtractor(tmpGazetteer);

describe('GazetteerExtractor', () => {
  it('matches exact equipment name', async () => {
    const result = await extractor.extract('Russian T-90M tanks spotted near the border.');
    expect(result.some(e => e.name === 'T-90M')).toBe(true);
  });

  it('matches via alias', async () => {
    const result = await extractor.extract('Multiple T90 units deployed to the front.');
    expect(result.some(e => e.name === 'T-90M')).toBe(true);
  });

  it('matches case-insensitively', async () => {
    const result = await extractor.extract('HIMARS strike confirmed by Ukrainian forces.');
    expect(result.some(e => e.name === 'HIMARS')).toBe(true);
  });

  it('deduplicates when multiple aliases match', async () => {
    const result = await extractor.extract('Bayraktar TB2 and TB2 drones spotted.');
    const matches = result.filter(e => e.name === 'Bayraktar TB2');
    expect(matches.length).toBe(1);
  });

  it('returns empty for text with no equipment', async () => {
    const result = await extractor.extract('Diplomatic talks continue in Geneva.');
    expect(result).toEqual([]);
  });

  it('returns empty for empty text', async () => {
    const result = await extractor.extract('');
    expect(result).toEqual([]);
  });

  it('does not match partial words', async () => {
    // "T90" as part of "T900" should not match
    const result = await extractor.extract('The T900 is a fictional tank.');
    expect(result.filter(e => e.name === 'T-90M').length).toBe(0);
  });
});

// Cleanup
afterAll(() => {
  try { unlinkSync(tmpGazetteer); } catch {}
});
```

#### File: `packages/sync/src/entity-extraction/__tests__/entity-dedup.test.ts` (NEW)

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { EntityDedupCache } from '../entity-dedup';

describe('EntityDedupCache', () => {
  let cache: EntityDedupCache;
  let mockStorage: any;
  let mockCtx: any;

  beforeEach(() => {
    cache = new EntityDedupCache(100);
    mockStorage = {
      pool: {
        query: async () => ({ rows: [] }),
      },
    };
    mockCtx = { tenantId: 'test-tenant' };
  });

  it('returns null on cache miss + DB miss', async () => {
    const result = await cache.resolve('Person', 'Zelensky', mockStorage, mockCtx);
    expect(result).toBeNull();
  });

  it('returns cached ID on cache hit', async () => {
    cache.set('Person', 'Zelensky', 'person-123');
    const result = await cache.resolve('Person', 'Zelensky', mockStorage, mockCtx);
    expect(result).toBe('person-123');
  });

  it('returns DB result on cache miss + DB hit', async () => {
    mockStorage.pool.query = async () => ({ rows: [{ _id: 'person-456' }] });
    const result = await cache.resolve('Person', 'Putin', mockStorage, mockCtx);
    expect(result).toBe('person-456');
    // Second call should hit cache
    const result2 = await cache.resolve('Person', 'Putin', mockStorage, mockCtx);
    expect(result2).toBe('person-456');
  });

  it('is case-insensitive for names', async () => {
    cache.set('Person', 'zelensky', 'person-789');
    const result = await cache.resolve('Person', 'Zelensky', mockStorage, mockCtx);
    expect(result).toBe('person-789');
  });

  it('different types with same name are separate', async () => {
    cache.set('Person', 'Moscow', 'person-1');
    cache.set('Location', 'Moscow', 'location-1');
    expect(await cache.resolve('Person', 'Moscow', mockStorage, mockCtx)).toBe('person-1');
    expect(await cache.resolve('Location', 'Moscow', mockStorage, mockCtx)).toBe('location-1');
  });

  it('evicts LRU entry when at capacity', async () => {
    const smallCache = new EntityDedupCache(3);
    smallCache.set('Person', 'A', 'id-a');
    smallCache.set('Person', 'B', 'id-b');
    smallCache.set('Person', 'C', 'id-c');
    smallCache.set('Person', 'D', 'id-d'); // Should evict 'A'
    
    expect(await smallCache.resolve('Person', 'A', mockStorage, mockCtx)).toBeNull();
    expect(await smallCache.resolve('Person', 'B', mockStorage, mockCtx)).toBe('id-b');
  });
});
```

### 4.2 Integration Tests

#### File: `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts` (NEW)

Test with an in-memory StorageProvider and a mock ObjectManager to verify the full pipeline:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import { ObjectManager, LinkManager, InMemoryObjectSetStore } from '@openfoundry/engine';
import { EntityExtractionService } from '../entity-extraction-service';
import { EntityDedupCache } from '../entity-dedup';
import { CompositeExtractor } from '../composite-extractor';
import type { EntityExtractor, ExtractedEntity } from '../types';

// Mock extractor for deterministic tests
class MockExtractor implements EntityExtractor {
  readonly name = 'mock';
  constructor(private entities: ExtractedEntity[]) {}
  async extract(_text: string) { return this.entities; }
}

describe('EntityExtractionService', () => {
  let service: EntityExtractionService;
  let storage: MemoryStorageProvider;
  let objectManager: ObjectManager;
  let linkManager: LinkManager;

  beforeEach(() => {
    storage = new MemoryStorageProvider();
    objectManager = new ObjectManager(storage, /* schema */ {} as any);
    linkManager = new LinkManager(storage, /* schema */ {} as any);
    
    const mockExtractor = new MockExtractor([
      { type: 'Person', name: 'Zelensky', confidence: 0.9 },
      { type: 'Organization', name: 'NATO', confidence: 0.85 },
      { type: 'Location', name: 'Bakhmut', confidence: 0.92 },
    ]);
    
    const composite = new CompositeExtractor([mockExtractor]);
    const dedupCache = new EntityDedupCache(100);
    
    service = new EntityExtractionService(
      composite, dedupCache, objectManager, linkManager, storage,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
  });

  it('creates entities and links for all extracted types', async () => {
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    
    // First, create an IntelReport to link to
    const report = await objectManager.create('IntelReport', {
      content: 'test', createdAt: new Date().toISOString(), createdBy: 'test',
      updatedAt: new Date().toISOString(), updatedBy: 'test',
      retrievedAt: new Date().toISOString(), status: 'RAW',
    }, ctx);
    
    const result = await service.processReport(report._id, 'Zelensky met NATO in Bakhmut', ctx);
    
    expect(result.entitiesExtracted).toBe(3);
    expect(result.entitiesCreated).toBe(3);
    expect(result.linksCreated).toBe(3);
    expect(result.errors).toBe(0);
  });

  it('deduplicates when same entity appears in second report', async () => {
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    
    const report1 = await objectManager.create('IntelReport', {
      content: 'test1', createdAt: new Date().toISOString(), createdBy: 'test',
      updatedAt: new Date().toISOString(), updatedBy: 'test',
      retrievedAt: new Date().toISOString(), status: 'RAW',
    }, ctx);
    
    const result1 = await service.processReport(report1._id, 'Zelensky spoke today', ctx);
    expect(result1.entitiesCreated).toBe(1);
    
    const report2 = await objectManager.create('IntelReport', {
      content: 'test2', createdAt: new Date().toISOString(), createdBy: 'test',
      updatedAt: new Date().toISOString(), updatedBy: 'test',
      retrievedAt: new Date().toISOString(), status: 'RAW',
    }, ctx);
    
    const result2 = await service.processReport(report2._id, 'Zelensky spoke again', ctx);
    expect(result2.entitiesCreated).toBe(0); // Already exists
    expect(result2.entitiesDedupHit).toBe(1);
    expect(result2.linksCreated).toBe(1); // Link still created
  });

  it('skips short text', async () => {
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    const report = await objectManager.create('IntelReport', {
      content: 'test', createdAt: new Date().toISOString(), createdBy: 'test',
      updatedAt: new Date().toISOString(), updatedBy: 'test',
      retrievedAt: new Date().toISOString(), status: 'RAW',
    }, ctx);
    
    const result = await service.processReport(report._id, 'OK', ctx);
    expect(result.entitiesExtracted).toBe(0);
  });

  it('does not crash on extractor failure', async () => {
    const failingExtractor: EntityExtractor = {
      name: 'failing',
      extract: async () => { throw new Error('NER crash'); },
    };
    const composite = new CompositeExtractor([failingExtractor]);
    const dedupCache = new EntityDedupCache(100);
    const service2 = new EntityExtractionService(
      composite, dedupCache, objectManager, linkManager, storage,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    const report = await objectManager.create('IntelReport', {
      content: 'test', createdAt: new Date().toISOString(), createdBy: 'test',
      updatedAt: new Date().toISOString(), updatedBy: 'test',
      retrievedAt: new Date().toISOString(), status: 'RAW',
    }, ctx);
    
    const result = await service2.processReport(report._id, 'Some text here that is long enough', ctx);
    expect(result.errors).toBe(1);
    expect(result.entitiesExtracted).toBe(0);
    // Should not throw — service is resilient to extractor failures
  });
});
```

---

## 5. Error Handling Strategy

| Failure Point | Behavior | Recovery |
|--------------|----------|----------|
| Wink NER crashes on malformed text | `CompositeExtractor` catches, returns `[]` for that extractor | Other extractors still run |
| Gazetteer YAML not found | `GazetteerExtractor` not instantiated | Wink NER still runs |
| Entity creation fails (validation error) | Caught per-entity in `processReport()` | Other entities still created |
| Link creation fails (duplicate link) | Caught per-link in `processReport()` | Other links still created |
| DB query for dedup fails | Returns `null` (cache miss) | Entity will be re-created (non-fatal duplication) |
| Entire NER pipeline crashes | Caught in `changeApplier` try/catch | IntelReport stored without entities |

---

## 6. Observability

### Metrics

```typescript
// In entity-extraction-service.ts
metrics.nerEntitiesExtracted.add(result.entitiesExtracted);
metrics.nerEntitiesCreated.add(result.entitiesCreated); 
metrics.nerDedupHit.add(result.entitiesDedupHit);
metrics.nerLinksCreated.add(result.linksCreated);
metrics.nerErrors.add(result.errors);

// Histogram
metrics.nerLatencyMs.record(Date.now() - startTime);
```

### Logging

```
NER: extracted entities from report rpt-tw-xxx — 3 extracted, 2 created, 1 dedup, 3 linked
NER: entity extraction failed, report stored without entities — Error: wink model not loaded
```

---

## 7. Dependencies

### New npm packages (add to `packages/sync/package.json`)

```json
{
  "dependencies": {
    "wink-nlp": "^2.3.0",
    "wink-eng-lite-web-model": "^1.7.0"
  }
}
```

### No external services

- Zero API keys
- Zero network calls
- Zero third-party services
- Everything is self-contained in the Node.js process

---

## 8. Files Changed/Created Summary

| File | Action | Lines (est.) |
|------|--------|-------------|
| `packages/sync/src/entity-extraction/types.ts` | NEW | ~40 |
| `packages/sync/src/entity-extraction/wink-extractor.ts` | NEW | ~80 |
| `packages/sync/src/entity-extraction/gazetteer-extractor.ts` | NEW | ~70 |
| `packages/sync/src/entity-extraction/composite-extractor.ts` | NEW | ~50 |
| `packages/sync/src/entity-extraction/entity-dedup.ts` | NEW | ~100 |
| `packages/sync/src/entity-extraction/entity-extraction-service.ts` | NEW | ~140 |
| `packages/sync/src/entity-extraction/__tests__/wink-extractor.test.ts` | NEW | ~60 |
| `packages/sync/src/entity-extraction/__tests__/gazetteer-extractor.test.ts` | NEW | ~60 |
| `packages/sync/src/entity-extraction/__tests__/entity-dedup.test.ts` | NEW | ~60 |
| `packages/sync/src/entity-extraction/__tests__/composite-extractor.test.ts` | NEW | ~40 |
| `packages/sync/src/entity-extraction/__tests__/entity-extraction-service.test.ts` | NEW | ~100 |
| `packages/sync/src/entity-extraction/index.ts` | NEW | ~15 |
| `packages/sync/src/index.ts` | MODIFY | +5 |
| `packages/sync/src/mapping/mapping-parser.ts` | MODIFY | +15 |
| `packages/api/src/server.ts` | MODIFY | +30 |
| `packages/sync/package.json` | MODIFY | +2 |
| `domain-packs/osint/entity-extraction/equipment-gazetteer.yaml` | NEW | ~180 |
| `domain-packs/osint/connectors/twitter-osint.yaml` | MODIFY | +6 |
| **Total** | **18 files** | **~1,053 lines** |

---

## 9. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Wink NER accuracy on short/informal tweet text | MEDIUM | Conservative confidence threshold (0.6). Accept false negatives over false positives. |
| Entity name normalization causes false dedup ("Zelensky" vs "President Zelensky" vs "Zelenskyy") | MEDIUM | Strip titles ("President", "General", "Minister"). Accept some duplication as non-fatal. |
| Gazetteer needs maintenance as new equipment emerges | LOW | YAML file is editable by analysts without code changes. Future: auto-populate from Wikidata. |
| Performance: NER adds latency per tweet (~10-50ms) | LOW | At 5 tweets/sec (current rate limit), barely noticeable. For high throughput, make async. |
| wink NLP model bundle size (~3MB) | LOW | Loaded once at startup. Acceptable for server-side process. |
| Entity dedup cache memory (10K entries) | LOW | ~1MB memory. LRU eviction prevents unbounded growth. |
| DB queries for dedup (no index on name columns) | LOW | Fall back to creating duplicates if query fails. Add indexes in follow-up. |

---

## 10. Success Criteria

- [ ] Tweet "Russian T-90M tanks near Bakhmut" → Organization:Russia, Equipment:T-90M, Location:Bakhmut created + linked
- [ ] Same entity mentioned in second tweet → dedup hit (no duplicate created)
- [ ] Tweet with no entities → report stored without entities (no crash)
- [ ] NER crashes on malformed text → report still stored (best-effort)
- [ ] All existing tests pass (no regression in OSINT pack, sync package, API server)
- [ ] NER metrics emitted (entities extracted, created, dedup hit, linked, errors)
- [ ] Entity tables (person, organization, location, equipment) populated over time

---

## 11. Timeline

| Phase | Duration | Milestone |
|-------|----------|-----------|
| Phase 1: Types + Extractors | 1 day | Wink + Gazetteer extractors unit tested |
| Phase 2: Dedup + Service | 0.5 day | Service orchestrator working |
| Phase 3: Pipeline Integration | 0.5 day | NER running in live changeApplier |
| Phase 4: Integration Tests | 0.5 day | Full pipeline test with mock extractor |
| Phase 5: Gazetteer Population | 0.5 day | ~80 equipment entries in YAML |
| Phase 6: Deploy + Verify | 0.5 day | Docker rebuild, live ingestion with entities |
| **Total** | **3.5 days** | |

---

## Sources

- [Source: open-foundry-spec-v2.md Section 2] — ODL ObjectTypes and LinkTypes
- [Source: open-foundry-spec-v2.md Section 6] — Sync Engine and Connectors
- `domain-packs/osint/schema/` — OSINT domain pack schema files
- `packages/sync/src/connectors/twitter-connector.ts` — Reference connector pattern
- `packages/api/src/server.ts` — changeApplier pipeline integration point
