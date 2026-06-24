import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EntityExtractionService } from '../entity-extraction-service.js';
import { EntityDedupCache } from '../entity-dedup.js';
import { CompositeExtractor } from '../composite-extractor.js';
import type { EntityExtractor, ExtractedEntity } from '../types.js';

class MockExtractor implements EntityExtractor {
  readonly name = 'mock';
  constructor(private entities: ExtractedEntity[]) {}
  async extract(_text: string): Promise<ExtractedEntity[]> { return this.entities; }
}

function createMockObjectManager() {
  let idCounter = 0;
  return {
    create: vi.fn().mockImplementation(async (_type: string, _props: Record<string, unknown>, _ctx: unknown) => {
      idCounter++;
      return { _id: `entity-${idCounter}` };
    }),
  };
}

function createMockLinkManager() {
  return {
    createLink: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockStorage() {
  return {
    pool: { query: async () => ({ rows: [] }) },
  };
}

describe('EntityExtractionService', () => {
  let objectManager: ReturnType<typeof createMockObjectManager>;
  let linkManager: ReturnType<typeof createMockLinkManager>;
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    objectManager = createMockObjectManager();
    linkManager = createMockLinkManager();
    storage = createMockStorage();
  });

  it('creates entities and links for all extracted types', async () => {
    const mockExtractor = new MockExtractor([
      { type: 'Person', name: 'Zelensky', confidence: 0.9 },
      { type: 'Organization', name: 'NATO', confidence: 0.85 },
      { type: 'Location', name: 'Bakhmut', confidence: 0.92 },
    ]);
    const composite = new CompositeExtractor([mockExtractor]);
    const dedupCache = new EntityDedupCache(100);
    const service = new EntityExtractionService(
      composite, dedupCache, objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );

    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    const result = await service.processReport('report-1', 'Zelensky met NATO in Bakhmut', ctx as any);

    expect(result.entitiesExtracted).toBe(3);
    expect(result.entitiesCreated).toBe(3);
    expect(result.linksCreated).toBe(3);
    expect(result.errors).toBe(0);
  });

  it('deduplicates when same entity appears in second report', async () => {
    const zelenskyOnly = new MockExtractor([
      { type: 'Person', name: 'Zelensky', confidence: 0.9 },
    ]);
    const composite = new CompositeExtractor([zelenskyOnly]);
    const dedupCache = new EntityDedupCache(100);
    const service = new EntityExtractionService(
      composite, dedupCache, objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );

    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    const result1 = await service.processReport('report-1', 'Zelensky spoke today', ctx as any);
    expect(result1.entitiesCreated).toBe(1);

    const result2 = await service.processReport('report-2', 'Zelensky spoke again', ctx as any);
    expect(result2.entitiesCreated).toBe(0);
    expect(result2.entitiesDedupHit).toBe(1);
    expect(result2.linksCreated).toBe(1);
  });

  it('skips short text', async () => {
    const mockExtractor = new MockExtractor([]);
    const composite = new CompositeExtractor([mockExtractor]);
    const dedupCache = new EntityDedupCache(100);
    const service = new EntityExtractionService(
      composite, dedupCache, objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );

    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    const result = await service.processReport('report-1', 'OK', ctx as any);
    expect(result.entitiesExtracted).toBe(0);
  });

  it('skips empty text', async () => {
    const mockExtractor = new MockExtractor([]);
    const composite = new CompositeExtractor([mockExtractor]);
    const dedupCache = new EntityDedupCache(100);
    const service = new EntityExtractionService(
      composite, dedupCache, objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );

    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    const result = await service.processReport('report-1', '', ctx as any);
    expect(result.entitiesExtracted).toBe(0);
  });

  it('handles extractor failure via CompositeExtractor gracefully', async () => {
    const throwingExtractor: EntityExtractor = {
      name: 'throwing',
      extract: async (_text: string): Promise<ExtractedEntity[]> => { throw new Error('NER crash'); },
    };
    // CompositeExtractor catches per-extractor failures, so service receives []
    const composite = new CompositeExtractor([throwingExtractor]);
    const dedupCache = new EntityDedupCache(100);
    const service = new EntityExtractionService(
      composite, dedupCache, objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );

    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    const result = await service.processReport('report-1', 'Some text here that is long enough', ctx as any);
    // CompositeExtractor catches failures — service sees empty results
    expect(result.entitiesExtracted).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('creates correct link types for each entity type', async () => {
    const extractor = new MockExtractor([
      { type: 'Person', name: 'Test Person', confidence: 0.9 },
      { type: 'Organization', name: 'Test Org', confidence: 0.9 },
      { type: 'Location', name: 'Test Loc', confidence: 0.9 },
      { type: 'Equipment', name: 'Test Eq', confidence: 0.9 },
    ]);
    const composite = new CompositeExtractor([extractor]);
    const dedupCache = new EntityDedupCache(100);
    const svc = new EntityExtractionService(
      composite, dedupCache, objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );

    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    await svc.processReport('report-1', 'Test Person and Test Org in Test Loc with Test Eq', ctx as any);

    const linkTypes = (linkManager.createLink as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(linkTypes).toContain('MentionsPerson');
    expect(linkTypes).toContain('MentionsOrganization');
    expect(linkTypes).toContain('MentionsLocation');
    expect(linkTypes).toContain('MentionsEquipment');
  });
});

describe('EntityDedup — intra-text span dedup', () => {
  let objectManager: ReturnType<typeof createMockObjectManager>;
  let linkManager: ReturnType<typeof createMockLinkManager>;
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    objectManager = createMockObjectManager();
    linkManager = createMockLinkManager();
    storage = createMockStorage();
  });

  it('removes substring-overlap same-type entity (Gen Keane + Keane)', async () => {
    const extractor = new MockExtractor([
      { type: 'Person', name: 'Gen Keane', confidence: 0.95 },
      { type: 'Person', name: 'Keane', confidence: 0.89 },
    ]);
    const composite = new CompositeExtractor([extractor]);
    const dedupCache = new EntityDedupCache(100);
    const svc = new EntityExtractionService(
      composite, dedupCache, objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    const result = await svc.processReport('r1', 'Gen Keane spoke, Keane replied', ctx as any);
    expect(result.entitiesCreated).toBe(1);
    expect(objectManager.create).toHaveBeenCalledTimes(2);  // Dual create: Person + IntelSubject
  });

  it('preserves different-type overlaps (Trump Person + Trump Org)', async () => {
    const extractor = new MockExtractor([
      { type: 'Person', name: 'Trump', confidence: 0.9 },
      { type: 'Organization', name: 'Trump Org', confidence: 0.85 },
    ]);
    const composite = new CompositeExtractor([extractor]);
    const dedupCache = new EntityDedupCache(100);
    const svc = new EntityExtractionService(
      composite, dedupCache, objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    const result = await svc.processReport('r2', 'Trump met Trump Org', ctx as any);
    expect(result.entitiesCreated).toBe(2);
  });

  it('preserves non-overlapping entities', async () => {
    const extractor = new MockExtractor([
      { type: 'Person', name: 'Biden', confidence: 0.9 },
      { type: 'Person', name: 'Putin', confidence: 0.9 },
    ]);
    const composite = new CompositeExtractor([extractor]);
    const dedupCache = new EntityDedupCache(100);
    const svc = new EntityExtractionService(
      composite, dedupCache, objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    const result = await svc.processReport('r3', 'Biden met Putin', ctx as any);
    expect(result.entitiesCreated).toBe(2);
  });

  it('does NOT swallow short name within longer word (Eva vs Evan)', async () => {
    const extractor = new MockExtractor([
      { type: 'Person', name: 'Eva', confidence: 0.9 },
      { type: 'Person', name: 'Evan', confidence: 0.9 },
    ]);
    const composite = new CompositeExtractor([extractor]);
    const dedupCache = new EntityDedupCache(100);
    const svc = new EntityExtractionService(
      composite, dedupCache, objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    const result = await svc.processReport('r4', 'Eva and Evan arrived', ctx as any);
    expect(result.entitiesCreated).toBe(2);
  });

  it('does NOT swallow short country code within longer name (US vs Russia)', async () => {
    const extractor = new MockExtractor([
      { type: 'Location', name: 'US', confidence: 0.9 },
      { type: 'Location', name: 'Russia', confidence: 0.9 },
    ]);
    const composite = new CompositeExtractor([extractor]);
    const dedupCache = new EntityDedupCache(100);
    const svc = new EntityExtractionService(
      composite, dedupCache, objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    const result = await svc.processReport('r5', 'US and Russia', ctx as any);
    expect(result.entitiesCreated).toBe(2);
  });
});

describe('EntityDedup — normalization consistency', () => {
  let objectManager: ReturnType<typeof createMockObjectManager>;
  let linkManager: ReturnType<typeof createMockLinkManager>;
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    objectManager = createMockObjectManager();
    linkManager = createMockLinkManager();
    storage = createMockStorage();
  });

  it('title-stripped Person resolves to same entity (President Trump → Trump)', async () => {
    const dedupCache = new EntityDedupCache(100);
    // First report: "President Trump" is extracted
    const extractor1 = new MockExtractor([
      { type: 'Person', name: 'President Trump', confidence: 0.9 },
    ]);
    const svc1 = new EntityExtractionService(
      new CompositeExtractor([extractor1]), dedupCache,
      objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    await svc1.processReport('r1', 'President Trump spoke', ctx as any);

    // Second report: plain "Trump" — same cache, should dedup
    const extractor2 = new MockExtractor([
      { type: 'Person', name: 'Trump', confidence: 0.9 },
    ]);
    const svc2 = new EntityExtractionService(
      new CompositeExtractor([extractor2]), dedupCache,
      objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    const result2 = await svc2.processReport('r2', 'Trump replied', ctx as any);
    expect(result2.entitiesCreated).toBe(0);
    expect(result2.entitiesDedupHit).toBe(1);
  });

  it('bare Person resolves to same entity (Trump → President Trump)', async () => {
    const dedupCache = new EntityDedupCache(100);
    const extractor1 = new MockExtractor([
      { type: 'Person', name: 'Trump', confidence: 0.9 },
    ]);
    const svc1 = new EntityExtractionService(
      new CompositeExtractor([extractor1]), dedupCache,
      objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    await svc1.processReport('r1', 'Trump spoke', ctx as any);

    const extractor2 = new MockExtractor([
      { type: 'Person', name: 'President Trump', confidence: 0.9 },
    ]);
    const svc2 = new EntityExtractionService(
      new CompositeExtractor([extractor2]), dedupCache,
      objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    const result2 = await svc2.processReport('r2', 'President Trump replied', ctx as any);
    expect(result2.entitiesCreated).toBe(0);
    expect(result2.entitiesDedupHit).toBe(1);
  });

  it('Organization name is NOT title-stripped (General Electric = General Electric)', async () => {
    const dedupCache = new EntityDedupCache(100);
    const extractor1 = new MockExtractor([
      { type: 'Organization', name: 'General Electric', confidence: 0.9 },
    ]);
    const svc1 = new EntityExtractionService(
      new CompositeExtractor([extractor1]), dedupCache,
      objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    await svc1.processReport('r1', 'General Electric announced', ctx as any);

    // "Electric" alone should NOT match "General Electric" — different normalized keys
    const extractor2 = new MockExtractor([
      { type: 'Organization', name: 'Electric', confidence: 0.9 },
    ]);
    const svc2 = new EntityExtractionService(
      new CompositeExtractor([extractor2]), dedupCache,
      objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    const result2 = await svc2.processReport('r2', 'Electric power', ctx as any);
    expect(result2.entitiesCreated).toBe(1);
    expect(result2.entitiesDedupHit).toBe(0);
  });
});

describe('EntityExtractionService — two-phase link consistency', () => {
  let objectManager: ReturnType<typeof createMockObjectManager>;
  let linkManager: ReturnType<typeof createMockLinkManager>;
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    objectManager = createMockObjectManager();
    linkManager = createMockLinkManager();
    storage = createMockStorage();
  });

  it('creates all entities before any links (two-phase ordering)', async () => {
    const extractor = new MockExtractor([
      { type: 'Person', name: 'Zelensky', confidence: 0.9 },
      { type: 'Location', name: 'Kyiv', confidence: 0.9 },
      { type: 'Organization', name: 'NATO', confidence: 0.9 },
    ]);
    const composite = new CompositeExtractor([extractor]);
    const dedupCache = new EntityDedupCache(100);
    const svc = new EntityExtractionService(
      composite, dedupCache, objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };

    const result = await svc.processReport('r1', 'Zelensky in Kyiv with NATO', ctx as any);

    expect(result.entitiesCreated).toBe(3);
    expect(result.linksCreated).toBe(3);
    expect(result.errors).toBe(0);

    const createCalls = (objectManager.create as ReturnType<typeof vi.fn>).mock.calls;
    const linkCalls = (linkManager.createLink as ReturnType<typeof vi.fn>).mock.calls;

    // All 6 domain + intel creates
    expect(createCalls.length).toBe(6);
    // 3 links (one per entity type)
    const linkTypes = linkCalls.map((c: unknown[]) => c[0]);
    expect(linkTypes).toContain('MentionsPerson');
    expect(linkTypes).toContain('MentionsLocation');
    expect(linkTypes).toContain('MentionsOrganization');
  });

  it('recovers from stale cache entry — recreates deleted entity', async () => {
    const dedupCache = new EntityDedupCache(100);

    // Report 1: create "Zelensky" → cached as Person:zelensky → entity-1
    const extractor1 = new MockExtractor([
      { type: 'Person', name: 'Zelensky', confidence: 0.9 },
    ]);
    const svc1 = new EntityExtractionService(
      new CompositeExtractor([extractor1]), dedupCache,
      objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );
    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    await svc1.processReport('r1', 'Zelensky spoke', ctx as any);

    expect(dedupCache.size).toBe(1);
    expect(objectManager.create).toHaveBeenCalledTimes(2);  // Person + IntelSubject

    // Simulate DB clean: verifyId returns false (entity deleted from DB)
    const staleStorage = {
      pool: { query: vi.fn(async () => ({ rows: [] })) },
    };

    const exists = await dedupCache.verifyId('Person', 'entity-1', staleStorage as any, ctx as any);
    expect(exists).toBe(false);

    // Remove stale entry and recreate via fresh processReport
    dedupCache.remove('Person', 'Zelensky');
    expect(dedupCache.size).toBe(0);

    const extractor2 = new MockExtractor([
      { type: 'Person', name: 'Zelensky', confidence: 0.9 },
    ]);
    const freshObjectManager = createMockObjectManager();
    const freshLinkManager = createMockLinkManager();
    const svc2 = new EntityExtractionService(
      new CompositeExtractor([extractor2]), dedupCache,
      freshObjectManager as any, freshLinkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );

    const result = await svc2.processReport('r2', 'Zelensky returns', ctx as any);

    expect(result.entitiesCreated).toBe(1);   // entity recreated
    expect(result.linksCreated).toBe(1);       // link created for new entity
    expect(result.entitiesDedupHit).toBe(0);   // was not a dedup hit (stale → recreated)
    expect(freshObjectManager.create).toHaveBeenCalledTimes(2);  // dual-create
  });

  it('links still created for other entities when one link fails', async () => {
    const extractor = new MockExtractor([
      { type: 'Person', name: 'Zelensky', confidence: 0.9 },
      { type: 'Location', name: 'Kyiv', confidence: 0.9 },
    ]);
    const composite = new CompositeExtractor([extractor]);
    const dedupCache = new EntityDedupCache(100);
    const svc = new EntityExtractionService(
      composite, dedupCache, objectManager as any, linkManager as any, storage as any,
      { minConfidence: 0.6, maxEntities: 20, minTextLength: 10 },
    );

    // Fail call #3 — the first MentionsPerson link (calls #1-2 are ProfileForPerson)
    let callCount = 0;
    (linkManager.createLink as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 3) throw new Error('OBJECT_NOT_FOUND');
    });

    const ctx = { tenantId: 'test', actorId: 'test', traceId: 'test' };
    const result = await svc.processReport('r1', 'Zelensky in Kyiv', ctx as any);

    expect(result.entitiesCreated).toBe(2);
    expect(result.linksCreated).toBe(1);  // one MentionsPerson link failed, one succeeded
    expect(result.errors).toBe(1);         // link failure counted
    expect(linkManager.createLink).toHaveBeenCalledTimes(4);  // 2 ProfileForPerson + 2 MentionsPerson
  });
});
