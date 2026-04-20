/**
 * InMemoryObjectSetStore — in-memory implementation of ObjectSetStore.
 *
 * Map-based store keyed by id with tenant isolation.
 * Used for testing and MVP; production will delegate to a persistent store.
 */

import type { RequestContext, ObjectSetDefinition, ObjectSetStore } from '@openfoundry/spi';
import { generateUUIDv7 } from '../links/index.js';

export class InMemoryObjectSetStore implements ObjectSetStore {
  private readonly store = new Map<string, ObjectSetDefinition>();

  async create(
    ctx: RequestContext,
    def: Omit<ObjectSetDefinition, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ObjectSetDefinition> {
    const now = new Date().toISOString();
    const objectSet: ObjectSetDefinition = {
      ...def,
      id: generateUUIDv7(),
      createdAt: now,
      updatedAt: now,
      tenantId: ctx.tenantId,
    };
    this.store.set(objectSet.id, objectSet);
    return objectSet;
  }

  async get(ctx: RequestContext, id: string): Promise<ObjectSetDefinition | null> {
    const def = this.store.get(id);
    if (!def || def.tenantId !== ctx.tenantId) return null;
    // Visibility: only the creator or anyone if isPublic
    if (!def.isPublic && ctx.actorId && def.createdBy !== ctx.actorId) return null;
    return def;
  }

  async getByName(ctx: RequestContext, name: string): Promise<ObjectSetDefinition | null> {
    for (const def of this.store.values()) {
      if (def.name === name && def.tenantId === ctx.tenantId) {
        return def;
      }
    }
    return null;
  }

  async list(ctx: RequestContext, objectType?: string): Promise<ObjectSetDefinition[]> {
    const results: ObjectSetDefinition[] = [];
    for (const def of this.store.values()) {
      if (def.tenantId !== ctx.tenantId) continue;
      if (objectType && def.objectType !== objectType) continue;
      // Visibility: only public sets or sets created by the current user
      if (!def.isPublic && ctx.actorId && def.createdBy !== ctx.actorId) continue;
      results.push(def);
    }
    return results;
  }

  async update(
    ctx: RequestContext,
    id: string,
    updates: Partial<Pick<ObjectSetDefinition, 'name' | 'description' | 'filter' | 'orderBy' | 'limit' | 'aggregation' | 'isPublic'>>,
  ): Promise<ObjectSetDefinition> {
    const existing = this.store.get(id);
    if (!existing || existing.tenantId !== ctx.tenantId) {
      const error = {
        code: 'OBJECT_SET_NOT_FOUND',
        category: 'not_found' as const,
        message: `Object set ${id} not found`,
        retryable: false,
      };
      throw error;
    }

    const updated: ObjectSetDefinition = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return updated;
  }

  async delete(ctx: RequestContext, id: string): Promise<void> {
    const existing = this.store.get(id);
    if (!existing || existing.tenantId !== ctx.tenantId) {
      const error = {
        code: 'OBJECT_SET_NOT_FOUND',
        category: 'not_found' as const,
        message: `Object set ${id} not found`,
        retryable: false,
      };
      throw error;
    }
    this.store.delete(id);
  }

  /** Clear all records (test utility). */
  clear(): void {
    this.store.clear();
  }
}
