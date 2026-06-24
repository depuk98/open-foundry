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
 *
 * Tradeoff (ADR-012): purely in-memory — lost on container restart.
 * The batchResolve() DB fallback mitigates cold starts with batch queries
 * (N lookups → ≤4 queries), but near-duplicate detection relies on exact
 * normalized_name match only (no fuzzy matching).
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

  /** Remove a single entry from the cache. No-op if key not present. */
  remove(type: string, name: string): void {
    const key = this.dedupKey(type, name);
    this.cache.delete(key);
  }

  /**
   * Verify a cached entity ID still exists in the database.
   * Lightweight SELECT _id query — used to detect stale cache entries
   * after DB-cleaning operations that bypassed cache eviction.
   */
  async verifyId(
    type: string,
    id: string,
    storage: StorageProvider,
    ctx: RequestContext,
  ): Promise<boolean> {
    try {
      const tableName = this.tableNameFor(type);
      const pgStorage = storage as unknown as StorageWithPool;
      if (!pgStorage.pool) return false;

      const result = await pgStorage.pool.query(
        `SELECT "_id" FROM public.${tableName}
         WHERE "_tenant_id" = $1 AND "_id" = $2
         AND "_deleted_at" IS NULL LIMIT 1`,
        [ctx.tenantId, id],
      );

      return result.rows.length > 0;
    } catch {
      return false;
    }
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
        const linkTable = this.linkTableFor(items[0]!.type);
        let sql: string;
        if (linkTable) {
          sql = `SELECT l."_from_id" AS "_id", t."normalized_name"
 FROM public.${table} t
 JOIN public.${linkTable} l
   ON l."_to_id" = t."_id"
   AND l."_tenant_id" = t."_tenant_id"
   AND l."_deleted_at" IS NULL
 WHERE t."_tenant_id" = $1 AND t."normalized_name" = ANY($2)
   AND t."_deleted_at" IS NULL`;
        } else {
          sql = `SELECT "_id", "normalized_name" FROM public.${table}
 WHERE "_tenant_id" = $1 AND "normalized_name" = ANY($2)
   AND "_deleted_at" IS NULL`;
        }
        const result = await pgStorage.pool.query(sql, [ctx.tenantId, names]);

        // Build lookup map from DB results
        const dbMap = new Map<string, string>();
        for (const row of result.rows) {
          if (row && row._id && row.normalized_name) {
            dbMap.set(row.normalized_name as string, row._id as string);
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

      const linkTable = this.linkTableFor(type);
      let sql: string;
      if (linkTable) {
        sql = `SELECT l."_from_id" AS "_id" FROM public.${tableName} t
 JOIN public.${linkTable} l
   ON l."_to_id" = t."_id"
   AND l."_tenant_id" = t."_tenant_id"
   AND l."_deleted_at" IS NULL
 WHERE t."_tenant_id" = $1 AND t."normalized_name" = $2
   AND t."_deleted_at" IS NULL LIMIT 1`;
      } else {
        sql = `SELECT "_id" FROM public.${tableName}
 WHERE "_tenant_id" = $1 AND "normalized_name" = $2
   AND "_deleted_at" IS NULL LIMIT 1`;
      }

      const result = await pgStorage.pool.query(sql, [ctx.tenantId, name]);

      if (result.rows.length > 0 && result.rows[0]) {
        return result.rows[0]._id as string;
      }
    } catch {
      // Table may not exist yet, or column may not have index
    }
    return null;
  }

  // All table names are hardcoded constants — no user input is interpolated into SQL identifiers.
  private tableNameFor(type: string): string {
    switch (type) {
      case 'Person': return 'person';
      case 'Organization': return 'organization';
      case 'Location': return 'location';
      case 'Equipment': return 'equipment';
      case 'Event': return 'intel_event';
      case 'WeaponSystem': return 'equipment';
      case 'MilitaryUnit': return 'organization';
      case 'ArmedGroup': return 'organization';
      case 'ConflictZone': return 'location';
      default: return type.toLowerCase();
    }
  }

  /**
   * Returns the link table to JOIN for translating domain IDs to Intel extension IDs.
   * Returns null for types that don't need a JOIN (Event has no domain counterpart).
   */
  private linkTableFor(type: string): string | null {
    switch (type) {
      case 'Person': return 'profile_for_person';
      case 'Organization':
      case 'MilitaryUnit':
      case 'ArmedGroup': return 'org_profile_for_organization';
      case 'Location':
      case 'ConflictZone': return 'location_profile_for_location';
      case 'Equipment':
      case 'WeaponSystem': return 'equipment_profile_for_equipment';
      default: return null;  // Event and unknown types — no JOIN
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
