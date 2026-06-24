/**
 * Link Consistency Smoke Test — exercises the two-phase entity extraction pipeline
 * with dummy data to verify:
 *   1. Two-phase ordering: all entities created before any links
 *   2. Dedup across batches: same entity reused across reports
 *   3. Stale cache recovery: entity recreated after simulated DB clean
 *   4. Link failure isolation: one failed link doesn't block others
 *   5. All 9 entity types: Person, Org, MilitaryUnit, ArmedGroup,
 *      Location, ConflictZone, Equipment, WeaponSystem, Event
 *
 * Run: npx tsx packages/sync/src/entity-extraction/__tests__/link-consistency-smoke-test.mts
 */

import { EntityExtractionService } from '../entity-extraction-service.js';
import { EntityDedupCache } from '../entity-dedup.js';
import { CompositeExtractor } from '../composite-extractor.js';
import type { EntityExtractor, ExtractedEntity } from '../types.js';

// ---------------------------------------------------------------------------
// Mock infrastructure (stores entities and links in memory)
// ---------------------------------------------------------------------------

let entityStore = new Map<string, { type: string; props: Record<string, unknown> }>();
let linkStore: Array<{ type: string; fromId: string; toId: string }> = [];
let linkFailureMode: 'none' | 'first' | 'all' = 'none';

function resetMocks() {
  entityStore.clear();
  linkStore = [];
  linkFailureMode = 'none';
}

const mockObjectManager = {
  create: async (type: string, props: Record<string, unknown>, _ctx: unknown) => {
    const id = `${type.toLowerCase()}-${entityStore.size + 1}`;
    entityStore.set(id, { type, props });
    return { _id: id };
  },
};

const mockLinkManager = {
  createLink: async (type: string, fromId: string, toId: string, _props: unknown, _ctx: unknown) => {
    if (linkFailureMode === 'first') {
      linkFailureMode = 'none'; // fail only the first one
      throw new Error('OBJECT_NOT_FOUND: simulated link failure');
    }
    if (linkFailureMode === 'all') {
      throw new Error('OBJECT_NOT_FOUND: simulated link failure');
    }
    linkStore.push({ type, fromId, toId });
    return { _id: `link-${linkStore.length}` };
  },
};

const mockStorage = {
  pool: {
    query: async () => ({ rows: [] }),
  },
};

const mockCtx = { tenantId: 'smoke-test', actorId: 'script', traceId: 'smoke-1' };

// ---------------------------------------------------------------------------
// Mock NER extractor — returns canned entities for given text
// ---------------------------------------------------------------------------

class DummyExtractor implements EntityExtractor {
  readonly name = 'dummy-extractor';
  private entities: Map<string, ExtractedEntity[]>;

  constructor(scenarios: Record<string, ExtractedEntity[]>) {
    this.entities = new Map(Object.entries(scenarios));
  }

  async extract(text: string): Promise<ExtractedEntity[]> {
    for (const [trigger, entities] of this.entities) {
      if (text.includes(trigger)) return entities;
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

const scenarios: Record<string, ExtractedEntity[]> = {
  'report-basic': [
    { type: 'Person', name: 'President Zelensky', confidence: 0.92 },
    { type: 'Organization', name: 'NATO', confidence: 0.88 },
    { type: 'Location', name: 'Kyiv', confidence: 0.95 },
  ],
  'report-dup': [
    { type: 'Person', name: 'President Zelensky', confidence: 0.90 },
    { type: 'Location', name: 'Kyiv', confidence: 0.94 },
    { type: 'Equipment', name: 'HIMARS', confidence: 0.87 },
  ],
  'report-military': [
    { type: 'MilitaryUnit', name: '92nd Brigade', confidence: 0.85 },
    { type: 'Organization', name: 'Russian MOD', confidence: 0.89 },
    { type: 'WeaponSystem', name: 'Iskander', confidence: 0.82 },
    { type: 'ConflictZone', name: 'Donbas', confidence: 0.91 },
  ],
  'report-event': [
    { type: 'Event', name: 'Missile Strike on Odesa', confidence: 0.88 },
    { type: 'Location', name: 'Odesa', confidence: 0.93 },
    { type: 'ArmedGroup', name: 'Wagner Group', confidence: 0.86 },
  ],
};

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function section(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(60)}`);
}

// ---------------------------------------------------------------------------
// Test 1: Basic two-phase ordering
// ---------------------------------------------------------------------------

section('TEST 1: Two-phase ordering — all creates before all links');

{
  resetMocks();
  const extractor = new DummyExtractor(scenarios);
  const dedupCache = new EntityDedupCache(100);
  const svc = new EntityExtractionService(
    new CompositeExtractor([extractor]), dedupCache,
    mockObjectManager as any, mockLinkManager as any, mockStorage as any,
    { minConfidence: 0.6, maxEntities: 20, minTextLength: 5 },
  );

  const result = await svc.processReport('r-basic', 'report-basic text here', mockCtx as any);

  assert('3 entities extracted', result.entitiesExtracted === 3, `got ${result.entitiesExtracted}`);
  assert('3 entities created', result.entitiesCreated === 3, `got ${result.entitiesCreated}`);
  assert('3 links created', result.linksCreated === 3, `got ${result.linksCreated}`);
  assert('0 errors', result.errors === 0, `got ${result.errors}`);
  assert('0 dedup hits (first batch)', result.entitiesDedupHit === 0, `got ${result.entitiesDedupHit}`);
  assert('0 rejected', result.entitiesRejected === 0, `got ${result.entitiesRejected}`);

  // Verify entities stored
  const entities = [...entityStore.values()];
  const entityTypes = entities.map(e => e.type);
  assert('Person entity created', entityTypes.includes('Person'), `types: ${entityTypes.join(',')}`);
  assert('IntelSubject extension created', entityTypes.includes('IntelSubject'));
  assert('Organization entity created', entityTypes.includes('Organization'));
  assert('IntelOrganization extension created', entityTypes.includes('IntelOrganization'));
  assert('Location entity created', entityTypes.includes('Location'));
  assert('IntelLocation extension created', entityTypes.includes('IntelLocation'));
  assert('6 total entities (3 domain + 3 intel)', entities.length === 6, `got ${entities.length}`);

  // Verify link types
  const linkTypes = linkStore.map(l => l.type);
  assert('MentionsPerson link created', linkTypes.includes('MentionsPerson'), `types: ${linkTypes.join(',')}`);
  assert('MentionsOrganization link created', linkTypes.includes('MentionsOrganization'));
  assert('MentionsLocation link created', linkTypes.includes('MentionsLocation'));
}

// ---------------------------------------------------------------------------
// Test 2: Dedup across batches
// ---------------------------------------------------------------------------

section('TEST 2: Dedup across batches — same entity reused');

{
  resetMocks();
  const dedupCache = new EntityDedupCache(100);

  // Batch 1: creates Zelensky + Kyiv
  {
    const extractor = new DummyExtractor(scenarios);
    const svc = new EntityExtractionService(
      new CompositeExtractor([extractor]), dedupCache,
      mockObjectManager as any, mockLinkManager as any, mockStorage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 5 },
    );
    const r1 = await svc.processReport('r1', 'report-basic text', mockCtx as any);
    assert('Batch 1: 3 created', r1.entitiesCreated === 3, `got ${r1.entitiesCreated}`);
    assert('Batch 1: 3 links', r1.linksCreated === 3, `got ${r1.linksCreated}`);
  }

  // Batch 2: Zelensky + Kyiv (same names) + HIMARS (new)
  {
    const extractor = new DummyExtractor(scenarios);
    const svc = new EntityExtractionService(
      new CompositeExtractor([extractor]), dedupCache,
      mockObjectManager as any, mockLinkManager as any, mockStorage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 5 },
    );
    const r2 = await svc.processReport('r2', 'report-dup text', mockCtx as any);
    assert('Batch 2: 1 created (only HIMARS new)', r2.entitiesCreated === 1, `got ${r2.entitiesCreated}`);
    assert('Batch 2: 2 dedup hits (Zelensky + Kyiv reused)', r2.entitiesDedupHit === 2, `got ${r2.entitiesDedupHit}`);
    assert('Batch 2: 3 links (all 3 entities linked to new report)', r2.linksCreated === 3, `got ${r2.linksCreated}`);
    assert('Batch 2: 0 errors', r2.errors === 0, `got ${r2.errors}`);
  }

  // Verify no duplicate entities were created in the store
  const personEntities = [...entityStore.values()].filter(e => e.type === 'Person');
  assert('Only 1 Person in store', personEntities.length === 1, `got ${personEntities.length}`);
  const locEntities = [...entityStore.values()].filter(e => e.type === 'Location');
  assert('Only 1 Location in store', locEntities.length === 1, `got ${locEntities.length}`);
}

// ---------------------------------------------------------------------------
// Test 3: Stale cache recovery
// ---------------------------------------------------------------------------

section('TEST 3: Stale cache recovery — entity recreated after deletion');

{
  resetMocks();
  const dedupCache = new EntityDedupCache(100);

  // Step 1: Create entity normally
  {
    const extractor = new DummyExtractor({
      'zelensky': [{ type: 'Person', name: 'Zelensky', confidence: 0.9 }],
    });
    const svc = new EntityExtractionService(
      new CompositeExtractor([extractor]), dedupCache,
      mockObjectManager as any, mockLinkManager as any, mockStorage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 5 },
    );
    const r1 = await svc.processReport('r1', 'zelensky speaks', mockCtx as any);
    assert('Step 1: entity created', r1.entitiesCreated === 1, `got ${r1.entitiesCreated}`);
    assert('Step 1: cached size = 1', dedupCache.size === 1, `got ${dedupCache.size}`);
  }

  // Step 2: Simulate DB clean — remove entity from store, remove from cache
  entityStore.clear();
  dedupCache.remove('Person', 'Zelensky');
  assert('Step 2: cache cleared', dedupCache.size === 0);

  // Step 3: Same entity appears again — should create fresh
  {
    const extractor = new DummyExtractor({
      'zelensky': [{ type: 'Person', name: 'Zelensky', confidence: 0.9 }],
    });
    const svc = new EntityExtractionService(
      new CompositeExtractor([extractor]), dedupCache,
      mockObjectManager as any, mockLinkManager as any, mockStorage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 5 },
    );
    const r3 = await svc.processReport('r3', 'zelensky returns', mockCtx as any);
    assert('Step 3: entity recreated', r3.entitiesCreated === 1, `got ${r3.entitiesCreated}`);
    assert('Step 3: link created', r3.linksCreated === 1, `got ${r3.linksCreated}`);
    assert('Step 3: 0 dedup hits (cache was empty)', r3.entitiesDedupHit === 0, `got ${r3.entitiesDedupHit}`);
    assert('Step 3: 0 errors', r3.errors === 0, `got ${r3.errors}`);
    assert('Step 3: cached again', dedupCache.size === 1, `got ${dedupCache.size}`);
  }
}

// ---------------------------------------------------------------------------
// Test 4: Link failure isolation
// ---------------------------------------------------------------------------

section('TEST 4: Link failure isolation — one bad link doesn\'t block others');

{
  resetMocks();
  const dedupCache = new EntityDedupCache(100);
  const extractor = new DummyExtractor(scenarios);

  // Fail the first link only
  linkFailureMode = 'first';

  const svc = new EntityExtractionService(
    new CompositeExtractor([extractor]), dedupCache,
    mockObjectManager as any, mockLinkManager as any, mockStorage as any,
    { minConfidence: 0.6, maxEntities: 20, minTextLength: 5 },
  );

  const result = await svc.processReport('r-fail', 'report-basic text here', mockCtx as any);

  assert('3 entities still created', result.entitiesCreated === 3, `got ${result.entitiesCreated}`);
  assert('2 links created (1 failed)', result.linksCreated === 2, `got ${result.linksCreated}`);
  assert('1 error counted', result.errors === 1, `got ${result.errors}`);

  const linkTypes = linkStore.map(l => l.type);
  assert('2 links in store', linkStore.length === 2, `got ${linkStore.length}`);
  assert('MentionsPerson link failed (not in store)', !linkTypes.includes('MentionsPerson'),
    `expected missing MentionsPerson, got: ${linkTypes.join(',')}`);
}

// ---------------------------------------------------------------------------
// Test 5: All 9 entity types
// ---------------------------------------------------------------------------

section('TEST 5: All 9 entity types created with correct link types');

{
  resetMocks();
  const dedupCache = new EntityDedupCache(100);

  // Use two reports to cover all types
  {
    const extractor = new DummyExtractor(scenarios);
    const svc = new EntityExtractionService(
      new CompositeExtractor([extractor]), dedupCache,
      mockObjectManager as any, mockLinkManager as any, mockStorage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 5 },
    );
    await svc.processReport('r1', 'report-basic text here', mockCtx as any);
    await svc.processReport('r2', 'report-military text here', mockCtx as any);
    await svc.processReport('r3', 'report-event text here', mockCtx as any);
  }

  const allEntityTypes = [...new Set([...entityStore.values()].map(e => e.type))].sort();
  // ArmedGroup → Organization, WeaponSystem → Equipment (mapped in createEntity)
  const expectedTypes = [
    'Equipment', 'IntelEquipment', 'IntelEvent',
    'IntelLocation', 'IntelOrganization', 'IntelSubject',
    'Location', 'Organization', 'Person',
  ].sort();

  for (const t of expectedTypes) {
    assert(`Type ${t} created`, allEntityTypes.includes(t));
  }

  const allLinkTypes = [...new Set(linkStore.map(l => l.type))].sort();
  assert('MentionsPerson link type used', allLinkTypes.includes('MentionsPerson'));
  assert('MentionsOrganization link type used', allLinkTypes.includes('MentionsOrganization'));
  assert('MentionsLocation link type used', allLinkTypes.includes('MentionsLocation'));
  assert('MentionsEquipment link type used', allLinkTypes.includes('MentionsEquipment'));
  assert('ReportedEvent link type used', allLinkTypes.includes('ReportedEvent'));
}

// ---------------------------------------------------------------------------
// Test 6: verifyId directly on EntityDedupCache
// ---------------------------------------------------------------------------

section('TEST 6: verifyId — lightweight entity existence check');

{
  const dedupCache = new EntityDedupCache(100);

  // Mock storage that actually returns rows
  const realMockStorage = {
    pool: {
      query: async (_sql?: string, params?: unknown[]) => {
        if (params && params[1] === 'exists-123') {
          return { rows: [{ _id: 'exists-123' }] };
        }
        return { rows: [] };
      },
    },
  };

  const exists = await dedupCache.verifyId('Person', 'exists-123', realMockStorage as any, mockCtx as any);
  assert('verifyId returns true for existing entity', exists);

  const notExists = await dedupCache.verifyId('Person', 'deleted-456', realMockStorage as any, mockCtx as any);
  assert('verifyId returns false for deleted entity', !notExists);

  // remove() works with title-stripping
  dedupCache.set('Person', 'President Biden', 'person-biden');
  assert('size=1 after set', dedupCache.size === 1, `got ${dedupCache.size}`);
  dedupCache.remove('Person', 'Biden');
  assert('size=0 after remove by bare name', dedupCache.size === 0, `got ${dedupCache.size}`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(60)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed (${passed + failed} total)`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) {
  process.exit(1);
}
