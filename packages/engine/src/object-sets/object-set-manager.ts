/**
 * ObjectSetManager — manages saved query definitions and their execution.
 *
 * Provides CRUD operations on ObjectSetDefinitions and the ability to
 * execute a saved query or aggregation against the ObjectManager.
 */

import type {
  RequestContext,
  ObjectSetDefinition,
  ObjectSetStore,
  ObjectPage,
  AggregateResult,
  PlatformError,
} from '@openfoundry/spi';
import type { ObjectManager } from '../objects/object-manager.js';

export class ObjectSetManager {
  constructor(
    private readonly store: ObjectSetStore,
    private readonly objectManager: ObjectManager,
  ) {}

  async create(
    def: Omit<ObjectSetDefinition, 'id' | 'createdAt' | 'updatedAt'>,
    ctx: RequestContext,
  ): Promise<ObjectSetDefinition> {
    return this.store.create(ctx, def);
  }

  async get(id: string, ctx: RequestContext): Promise<ObjectSetDefinition | null> {
    return this.store.get(ctx, id);
  }

  async getByName(name: string, ctx: RequestContext): Promise<ObjectSetDefinition | null> {
    return this.store.getByName(ctx, name);
  }

  async list(objectType: string | undefined, ctx: RequestContext): Promise<ObjectSetDefinition[]> {
    return this.store.list(ctx, objectType);
  }

  async update(
    id: string,
    updates: Partial<Pick<ObjectSetDefinition, 'name' | 'description' | 'filter' | 'orderBy' | 'limit' | 'aggregation' | 'isPublic'>>,
    ctx: RequestContext,
  ): Promise<ObjectSetDefinition> {
    return this.store.update(ctx, id, updates);
  }

  async delete(id: string, ctx: RequestContext): Promise<void> {
    return this.store.delete(ctx, id);
  }

  /**
   * Execute the saved query, returning a paginated object page.
   */
  async execute(
    id: string,
    ctx: RequestContext,
    pagination?: { limit?: number; offset?: number },
  ): Promise<ObjectPage> {
    const def = await this.store.get(ctx, id);
    if (!def) {
      const error: PlatformError = {
        code: 'OBJECT_SET_NOT_FOUND',
        category: 'not_found',
        message: `Object set ${id} not found`,
        retryable: false,
      };
      throw error;
    }

    const limit = pagination?.limit ?? def.limit;
    const offset = pagination?.offset ?? 0;

    return this.objectManager.query(
      def.objectType,
      def.filter ?? { and: [] },
      {
        limit,
        offset,
        orderBy: def.orderBy,
      },
      ctx,
    );
  }

  /**
   * Execute the saved aggregation query, if one is defined.
   */
  async executeAggregate(
    id: string,
    ctx: RequestContext,
  ): Promise<AggregateResult> {
    const def = await this.store.get(ctx, id);
    if (!def) {
      const error: PlatformError = {
        code: 'OBJECT_SET_NOT_FOUND',
        category: 'not_found',
        message: `Object set ${id} not found`,
        retryable: false,
      };
      throw error;
    }

    if (!def.aggregation) {
      const error: PlatformError = {
        code: 'INVALID_OPERATION',
        category: 'validation',
        message: `Object set ${id} has no aggregation defined`,
        retryable: false,
      };
      throw error;
    }

    return this.objectManager.aggregate(def.objectType, def.aggregation, ctx);
  }
}
