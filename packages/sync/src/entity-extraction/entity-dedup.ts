import type { StorageProvider, RequestContext } from '@openfoundry/spi';

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

// Title prefixes to strip before computing dedup cache keys.
// Only applied to Person type. Organization/Location names are preserved.
const TITLE_PATTERN = /^(President|General|Gen|Admiral|Colonel|Col\.?|Captain|Capt\.?|Major|Maj\.?|Lieutenant|Lt\.?|Sergeant|Sgt\.?|Secretary|Minister|Dr\.?|Mr\.?|Ms\.?|Mrs\.?|King|Queen|Prince|Princess|Sheikh|Ayatollah|Crown Prince|Sir|Lord|Lady|Dame|Bishop|Archbishop|Cardinal|Rabbi|Imam|Chancellor|Governor|Senator|Congressman|Congresswoman|Ambassador|Marshal|Commander|Chief)\s+/i;

const TITLE_STRIP_TYPES = new Set(['Person']);

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

    const existingId = await this.queryByName(type, this.normalizeForDedup(type, name), storage, ctx);
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
      const fieldName = this.fieldNameFor(type);

      const pgStorage = storage as unknown as StorageWithPool;
      if (!pgStorage.pool) return null;

      const result = await pgStorage.pool.query(
        `SELECT "_id" FROM public.${tableName}
         WHERE "_tenant_id" = $1 AND LOWER("${fieldName}") = LOWER($2)
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
      // Mapped types — stored in parent tables
      case 'WeaponSystem': return 'equipment';
      case 'MilitaryUnit': return 'organization';
      case 'ArmedGroup': return 'organization';
      case 'ConflictZone': return 'location';
      default: return type.toLowerCase();
    }
  }

  private fieldNameFor(type: string): string {
    switch (type) {
      case 'Person': return 'full_name';
      case 'Organization': return 'name';
      case 'Location': return 'name';
      case 'Equipment': return 'designation';
      case 'Event': return 'description';
      // Mapped types — use parent table field
      case 'WeaponSystem': return 'designation';
      case 'MilitaryUnit': return 'name';
      case 'ArmedGroup': return 'name';
      case 'ConflictZone': return 'name';
      default: return 'name';
    }
  }

  /**
   * Compute the dedup cache key for a given type and name.
   * Person names get title prefixes stripped so "President Trump" and "Trump"
   * resolve to the same cache key.
   */
  private dedupKey(type: string, name: string): string {
    const normalized = this.normalizeForDedup(type, name);
    return `${type}:${normalized}`;
  }

  /**
   * Normalize an entity name for dedup. Strips known title prefixes from
   * Person names. Loops to handle multi-title names ("Mr President Trump").
   * Organization, Location, Equipment names are never stripped.
   */
  private normalizeForDedup(type: string, name: string): string {
    const trimmed = name.trim().normalize('NFC');
    if (!TITLE_STRIP_TYPES.has(type)) return trimmed.toLowerCase();
    let result = trimmed;
    for (;;) {
      const stripped = result.replace(TITLE_PATTERN, '').trim();
      if (stripped === result) break;
      result = stripped;
    }
    // Guard: if all titles were stripped leaving empty, return original
    if (result.length === 0) return trimmed.toLowerCase();
    return result.toLowerCase();
  }
}
