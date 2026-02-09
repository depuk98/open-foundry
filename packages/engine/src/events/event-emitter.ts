/**
 * CloudEvent emitter for the Ontology Engine (Section 4.2).
 *
 * Produces CloudEvents 1.0 compliant events for all state changes
 * and publishes them to the configured EventBus.
 */

import type { CloudEvent, CloudEventType, RequestContext, DateTime } from '@openfoundry/spi';
import type { EventBus } from './event-bus.js';

/** Describes who/what caused the state change. */
export interface EventCause {
  actionType?: string;
  actionId?: string;
  actor?: string;
}

/** Describes field-level changes for update events. */
export type ChangeSet = Record<string, { old: unknown; new: unknown }>;

/** Data payload for object lifecycle events. */
export interface ObjectEventData {
  objectType: string;
  objectId: string;
  version: number;
  changes?: ChangeSet;
  causedBy?: EventCause;
}

let _eventCounter = 0;

function generateEventId(): string {
  _eventCounter++;
  return `evt-${Date.now()}-${_eventCounter}`;
}

/**
 * Emits CloudEvents for object lifecycle operations.
 */
export class EngineEventEmitter {
  private readonly source: string;
  private readonly bus: EventBus;

  constructor(bus: EventBus, source = 'openfoundry://engine/ontology') {
    this.source = source;
    this.bus = bus;
  }

  /** Emit an object.created event. */
  async emitObjectCreated(
    ctx: RequestContext,
    objectType: string,
    objectId: string,
    version: number,
    cause?: EventCause,
  ): Promise<void> {
    await this.emitObjectEvent('openfoundry.object.created', ctx, {
      objectType,
      objectId,
      version,
      causedBy: this.buildCause(ctx, cause),
    });
  }

  /** Emit an object.updated event. */
  async emitObjectUpdated(
    ctx: RequestContext,
    objectType: string,
    objectId: string,
    version: number,
    changes: ChangeSet,
    cause?: EventCause,
  ): Promise<void> {
    await this.emitObjectEvent('openfoundry.object.updated', ctx, {
      objectType,
      objectId,
      version,
      changes,
      causedBy: this.buildCause(ctx, cause),
    });
  }

  /** Emit an object.deleted event. */
  async emitObjectDeleted(
    ctx: RequestContext,
    objectType: string,
    objectId: string,
    version: number,
    cause?: EventCause,
  ): Promise<void> {
    await this.emitObjectEvent('openfoundry.object.deleted', ctx, {
      objectType,
      objectId,
      version,
      causedBy: this.buildCause(ctx, cause),
    });
  }

  private async emitObjectEvent(
    type: CloudEventType,
    _ctx: RequestContext,
    data: ObjectEventData,
  ): Promise<void> {
    const event: CloudEvent<ObjectEventData> = {
      specversion: '1.0',
      id: generateEventId(),
      source: this.source,
      type,
      subject: `${data.objectType}/${data.objectId}`,
      time: new Date().toISOString() as DateTime,
      datacontenttype: 'application/json',
      data,
    };
    await this.bus.publish(event);
  }

  private buildCause(ctx: RequestContext, cause?: EventCause): EventCause {
    return {
      ...cause,
      actor: cause?.actor ?? (ctx.actorId ? `user:${ctx.actorId}` : undefined),
    };
  }
}
