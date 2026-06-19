import { describe, it, expect, beforeEach } from 'vitest';
import { EntityDedupCache } from '../entity-dedup.js';

interface MockPool {
  query: () => Promise<{ rows: Array<Record<string, unknown>> }>;
}

describe('EntityDedupCache', () => {
  let cache: EntityDedupCache;
  let mockStorage: { pool: MockPool };
  let mockCtx: { tenantId: string };

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
    const result = await cache.resolve('Person', 'Zelensky', mockStorage as unknown as any, mockCtx as any);
    expect(result).toBeNull();
  });

  it('returns cached ID on cache hit', async () => {
    cache.set('Person', 'Zelensky', 'person-123');
    const result = await cache.resolve('Person', 'Zelensky', mockStorage as unknown as any, mockCtx as any);
    expect(result).toBe('person-123');
  });

  it('returns DB result on cache miss + DB hit', async () => {
    mockStorage.pool.query = async () => ({ rows: [{ _id: 'person-456' }] });
    const result = await cache.resolve('Person', 'Putin', mockStorage as unknown as any, mockCtx as any);
    expect(result).toBe('person-456');
    const result2 = await cache.resolve('Person', 'Putin', mockStorage as unknown as any, mockCtx as any);
    expect(result2).toBe('person-456');
  });

  it('is case-insensitive for names', async () => {
    cache.set('Person', 'zelensky', 'person-789');
    const result = await cache.resolve('Person', 'Zelensky', mockStorage as unknown as any, mockCtx as any);
    expect(result).toBe('person-789');
  });

  it('different types with same name are separate', async () => {
    cache.set('Person', 'Moscow', 'person-1');
    cache.set('Location', 'Moscow', 'location-1');
    expect(await cache.resolve('Person', 'Moscow', mockStorage as unknown as any, mockCtx as any)).toBe('person-1');
    expect(await cache.resolve('Location', 'Moscow', mockStorage as unknown as any, mockCtx as any)).toBe('location-1');
  });

  it('evicts LRU entry when at capacity', async () => {
    const smallCache = new EntityDedupCache(3);
    smallCache.set('Person', 'A', 'id-a');
    smallCache.set('Person', 'B', 'id-b');
    smallCache.set('Person', 'C', 'id-c');
    smallCache.set('Person', 'D', 'id-d');

    expect(await smallCache.resolve('Person', 'A', mockStorage as unknown as any, mockCtx as any)).toBeNull();
    expect(await smallCache.resolve('Person', 'B', mockStorage as unknown as any, mockCtx as any)).toBe('id-b');
  });
});

describe('EntityDedupCache — title stripping', () => {
  let cache: EntityDedupCache;
  let mockStorage: { pool: MockPool };
  let mockCtx: { tenantId: string };

  beforeEach(() => {
    cache = new EntityDedupCache(100);
    mockStorage = { pool: { query: async () => ({ rows: [] }) } };
    mockCtx = { tenantId: 'test-tenant' };
  });

  it('strips President from Person cache key', async () => {
    cache.set('Person', 'President Trump', 'id-1');
    const result = await cache.resolve('Person', 'Trump', mockStorage as any, mockCtx as any);
    expect(result).toBe('id-1');
  });

  it('strips Gen from Person cache key', async () => {
    cache.set('Person', 'Gen Keane', 'id-2');
    const result = await cache.resolve('Person', 'Keane', mockStorage as any, mockCtx as any);
    expect(result).toBe('id-2');
  });

  it('does not strip Organization names', async () => {
    cache.set('Organization', 'General Electric', 'id-3');
    const result = await cache.resolve('Organization', 'Electric', mockStorage as any, mockCtx as any);
    expect(result).toBeNull();
    const result2 = await cache.resolve('Organization', 'General Electric', mockStorage as any, mockCtx as any);
    expect(result2).toBe('id-3');
  });

  it('strips multi-level titles (Mr President)', async () => {
    cache.set('Person', 'Mr President Trump', 'id-4');
    const result = await cache.resolve('Person', 'Trump', mockStorage as any, mockCtx as any);
    expect(result).toBe('id-4');
  });

  it('strips Crown Prince (compound title)', async () => {
    cache.set('Person', 'Crown Prince Mohammed', 'id-5');
    const result = await cache.resolve('Person', 'Mohammed', mockStorage as any, mockCtx as any);
    expect(result).toBe('id-5');
  });

  it('case insensitive', async () => {
    cache.set('Person', 'PRESIDENT TRUMP', 'id-6');
    const result = await cache.resolve('Person', 'trump', mockStorage as any, mockCtx as any);
    expect(result).toBe('id-6');
  });

  it('bare name unchanged', async () => {
    cache.set('Person', 'Keane', 'id-7');
    const result = await cache.resolve('Person', 'Keane', mockStorage as any, mockCtx as any);
    expect(result).toBe('id-7');
  });

  it('strips Ayatollah title', async () => {
    cache.set('Person', 'Ayatollah Khamenei', 'id-8');
    const result = await cache.resolve('Person', 'Khamenei', mockStorage as any, mockCtx as any);
    expect(result).toBe('id-8');
  });

  it('strips period-abbreviated title (Lt.)', async () => {
    cache.set('Person', 'Lt. Smith', 'id-9');
    const result = await cache.resolve('Person', 'Smith', mockStorage as any, mockCtx as any);
    expect(result).toBe('id-9');
  });

  it('does not strip MilitaryUnit names', async () => {
    cache.set('MilitaryUnit', 'General Staff', 'id-10');
    const result = await cache.resolve('MilitaryUnit', 'Staff', mockStorage as any, mockCtx as any);
    expect(result).toBeNull();
    const result2 = await cache.resolve('MilitaryUnit', 'General Staff', mockStorage as any, mockCtx as any);
    expect(result2).toBe('id-10');
  });
});
