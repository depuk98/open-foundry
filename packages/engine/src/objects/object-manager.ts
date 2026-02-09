/**
 * ObjectManager — core object lifecycle management for the Ontology Engine.
 *
 * Implements create, get, update, delete, and query operations with
 * validation pipeline enforcement (Section 4.3) and event emission (Section 4.2).
 */

import type {
  StorageProvider,
  RequestContext,
  OntologyObject,
  FilterExpression,
  QueryOptions,
  ObjectPage,
  PlatformError,
} from '@openfoundry/spi';
import type { ParsedSchema } from '@openfoundry/odl';
import { getTracer, withSpan, SpanAttributes } from '@openfoundry/observability';
import {
  validateObjectProperties,
  validationError,
  type ValidationResult,
} from './validation.js';
import { EngineEventEmitter, type ChangeSet, type EventCause } from '../events/event-emitter.js';

const tracer = getTracer('engine', 'objectManager');

/** Configuration for the ObjectManager. */
export interface ObjectManagerConfig {
  storage: StorageProvider;
  schema: ParsedSchema;
  eventEmitter: EngineEventEmitter;
}

/**
 * Manages the full lifecycle of ontology objects.
 *
 * All mutating operations:
 * 1. Validate through the pipeline (Section 4.3)
 * 2. Delegate to the SPI storage provider
 * 3. Emit CloudEvents for state changes
 */
export class ObjectManager {
  private readonly storage: StorageProvider;
  private readonly schema: ParsedSchema;
  private readonly eventEmitter: EngineEventEmitter;

  constructor(config: ObjectManagerConfig) {
    this.storage = config.storage;
    this.schema = config.schema;
    this.eventEmitter = config.eventEmitter;
  }

  /**
   * Create a new object.
   * Validates properties, creates via SPI, emits object.created event.
   */
  async create(
    type: string,
    properties: Record<string, unknown>,
    ctx: RequestContext,
    cause?: EventCause,
  ): Promise<OntologyObject> {
    return withSpan(tracer, 'createObject', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'create',
    }, async () => {
      // Validate
      const validation = await this.validate(type, properties, ctx);
      if (!validation.valid) {
        throw validationError(validation.failures);
      }

      // Create via SPI
      const obj = await this.storage.createObject(ctx, type, properties);

      // Emit event
      await this.eventEmitter.emitObjectCreated(
        ctx,
        type,
        obj._id,
        obj._version,
        cause,
      );

      return obj;
    });
  }

  /**
   * Get an object by type and ID.
   * Pass-through to SPI — no validation needed for reads.
   */
  async get(
    type: string,
    id: string,
    ctx: RequestContext,
  ): Promise<OntologyObject | null> {
    return withSpan(tracer, 'getObject', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.OBJECT_ID]: id,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'get',
    }, async () => {
      return this.storage.getObject(ctx, type, id);
    });
  }

  /**
   * Update an existing object.
   * Validates new properties, updates via SPI, emits object.updated event.
   */
  async update(
    type: string,
    id: string,
    properties: Record<string, unknown>,
    ctx: RequestContext,
    cause?: EventCause,
  ): Promise<OntologyObject> {
    return withSpan(tracer, 'updateObject', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.OBJECT_ID]: id,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'update',
    }, async () => {
      // Get the existing object to compute changes
      const existing = await this.storage.getObject(ctx, type, id);
      if (!existing) {
        const error: PlatformError = {
          code: 'OBJECT_NOT_FOUND',
          category: 'not_found',
          message: `Object ${type}/${id} not found`,
          retryable: false,
        };
        throw error;
      }

      // Merge existing properties with updates for validation
      // (so required field checks work on partial updates)
      const merged = this.mergeProperties(existing, properties);

      // Validate the merged state
      const validation = await this.validate(type, merged, ctx, id);
      if (!validation.valid) {
        throw validationError(validation.failures);
      }

      // Update via SPI
      const updated = await this.storage.updateObject(ctx, type, id, properties);

      // Compute change set
      const changes = this.computeChanges(existing, properties);

      // Emit event
      await this.eventEmitter.emitObjectUpdated(
        ctx,
        type,
        id,
        updated._version,
        changes,
        cause,
      );

      return updated;
    });
  }

  /**
   * Delete an object (soft or hard).
   * Deletes via SPI, emits object.deleted event.
   */
  async delete(
    type: string,
    id: string,
    mode: 'soft' | 'hard',
    ctx: RequestContext,
    cause?: EventCause,
  ): Promise<void> {
    return withSpan(tracer, 'deleteObject', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.OBJECT_ID]: id,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'delete',
    }, async () => {
      // Get the existing object to know its version
      const existing = await this.storage.getObject(ctx, type, id);
      if (!existing) {
        const error: PlatformError = {
          code: 'OBJECT_NOT_FOUND',
          category: 'not_found',
          message: `Object ${type}/${id} not found`,
          retryable: false,
        };
        throw error;
      }

      // Delete via SPI
      await this.storage.deleteObject(ctx, type, id, mode);

      // Emit event
      await this.eventEmitter.emitObjectDeleted(
        ctx,
        type,
        id,
        existing._version,
        cause,
      );
    });
  }

  /**
   * Query objects by type with filters and options.
   * Pass-through to SPI — no validation needed for reads.
   */
  async query(
    type: string,
    filter: FilterExpression,
    options: QueryOptions | undefined,
    ctx: RequestContext,
  ): Promise<ObjectPage> {
    return withSpan(tracer, 'queryObjects', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'query',
    }, async () => {
      return this.storage.queryObjects(ctx, type, filter, options);
    });
  }

  /**
   * Run the validation pipeline for object properties.
   */
  private async validate(
    type: string,
    properties: Record<string, unknown>,
    ctx: RequestContext,
    existingId?: string,
  ): Promise<ValidationResult> {
    return validateObjectProperties(
      this.schema,
      type,
      properties,
      ctx,
      this.storage,
      existingId,
    );
  }

  /**
   * Merge existing object properties with update properties.
   * System fields (prefixed with _) are excluded from merge.
   */
  private mergeProperties(
    existing: OntologyObject,
    updates: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(existing)) {
      if (!key.startsWith('_')) {
        merged[key] = value;
      }
    }
    for (const [key, value] of Object.entries(updates)) {
      merged[key] = value;
    }
    return merged;
  }

  /**
   * Compute field-level changes between existing state and updates.
   */
  private computeChanges(
    existing: OntologyObject,
    updates: Record<string, unknown>,
  ): ChangeSet {
    const changes: ChangeSet = {};
    for (const [key, newValue] of Object.entries(updates)) {
      const oldValue = existing[key];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes[key] = { old: oldValue, new: newValue };
      }
    }
    return changes;
  }
}
