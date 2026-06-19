import type { StorageProvider, RequestContext } from '@openfoundry/spi';
import { normalizeForDedup } from './dedup-utils.js';

interface CacheEntry {
  entityId: string;
  accessedAt: number;
}

interface PoolQueryResult {
  rows: Array<Record<string, unknown>>;
}

interface StorageWithPool {
  pool?: {
    query: (sql: string, params: unknown[]) => Promise<PoolQueryResult>;
  };
}

/**
 * In-memory LRU cache for entity deduplication.
 * Prevents creating duplicate Person/Org/Location/Equipment objects
 * when the same name appears across multiple reports.
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
    const key = this.dedupKey(type, name);

    const cached = this.cache.get(key);
    if (cached) {
      cached.accessedAt = Date.now();
      return cached.entityId;
    }

    const existingId = await this.queryByName(type, normalizeForDedup(type, name), storage, ctx);
    if (existingId) {
      this.setRaw(key, existingId);
      return existingId;
    }

    return null;
  }

  /** Cache a newly created entity's ID. */
  set(type: string, name: string, entityId: string): void {
    const key = this.dedupKey(type, name);
    this.setRaw(key, entityId);
  }

  /** Clear the cache (useful for testing). */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Batch resolve multiple entity lookups.
   * Groups entities by table, sends one query per table using ANY($2),
   * and populates the cache for all hits. Reduces cold-start DB load
   * from N queries (one per entity) to at most 4 (one per table).
   */
  async batchResolve(
    entities: Array<{ type: string; name: string }>,
    storage: StorageProvider,
    ctx: RequestContext,
  ): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();

    // Skip entities already in cache
    const uncached: Array<{ type: string; name: string; key: string }> = [];
    for (const e of entities) {
      const normalized = normalizeForDedup(e.type, e.name);
      const key = `${e.type}:${normalized}`;
      const cached = this.cache.get(key);
      if (cached) {
        results.set(key, cached.entityId);
      } else {
        uncached.push({ type: e.type, name: normalized, key });
      }
    }

    if (uncached.length === 0) return results;

    const pgStorage = storage as unknown as StorageWithPool;
    if (!pgStorage.pool) {
      for (const e of uncached) results.set(e.key, null);
      return results;
    }

    // Group by table
    const byTable = new Map<string, typeof uncached>();
    for (const e of uncached) {
      const table = this.tableNameFor(e.type);
      if (!byTable.has(table)) byTable.set(table, []);
      byTable.get(table)!.push(e);
    }

    // One query per table
    for (const [table, items] of byTable) {
      try {
        const names = items.map(e => e.name);
        const placeholders = names.map((_, i) => `$${i + 2}`);
        const result = await pgStorage.pool.query(
          `SELECT "_id", "_normalized_name" FROM public.${table}
           WHERE "_tenant_id" = $1 AND "_normalized_name" = ANY($2)
           AND "_deleted_at" IS NULL`,
          [ctx.tenantId, names],
        );

        // Build lookup map from DB results
        const dbMap = new Map<string, string>();
        for (const row of result.rows) {
          if (row && row._id && row._normalized_name) {
            dbMap.set(row._normalized_name as string, row._id as string);
          }
        }

        // Populate results and cache
        for (const e of items) {
          const dbId = dbMap.get(e.name) ?? null;
          results.set(e.key, dbId);
          if (dbId) {
            this.setRaw(e.key, dbId);
          }
        }
      } catch {
        for (const e of items) results.set(e.key, null);
      }
    }

    return results;
  }

  private setRaw(key: string, entityId: string): void {
    if (this.cache.size >= this.maxSize) {
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.accessedAt < oldestTime) {
          oldestTime = v.accessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, { entityId, accessedAt: Date.now() });
  }

  private async queryByName(
    type: string,
    name: string,
    storage: StorageProvider,
    ctx: RequestContext,
  ): Promise<string | null> {
    try {
      const tableName = this.tableNameFor(type);

      const pgStorage = storage as unknown as StorageWithPool;
      if (!pgStorage.pool) return null;

      const result = await pgStorage.pool.query(
        `SELECT "_id" FROM public.${tableName}
         WHERE "_tenant_id" = $1 AND "_normalized_name" = $2
         AND "_deleted_at" IS NULL LIMIT 1`,
        [ctx.tenantId, name],
      );

      if (result.rows.length > 0 && result.rows[0]) {
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
      case 'Event': return 'event';
      case 'WeaponSystem': return 'equipment';
      case 'MilitaryUnit': return 'organization';
      case 'ArmedGroup': return 'organization';
      case 'ConflictZone': return 'location';
      default: return type.toLowerCase();
    }
  }

  /**
   * Compute the dedup cache key for a given type and name.
   * Person names get title prefixes stripped so "President Trump" and "Trump"
   * resolve to the same cache key.
   */
  private dedupKey(type: string, name: string): string {
    const normalized = normalizeForDedup(type, name);
    return `${type}:${normalized}`;
  }
}
