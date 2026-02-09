/**
 * WebSocket subscription manager (Section 8.1.4).
 *
 * Bridges CloudEvents from the engine EventBus into GraphQL PubSub,
 * handles ID and filter-based subscription routing, and enforces
 * authentication on WebSocket connections.
 */

import type { PubSub } from 'graphql-subscriptions';
import type { CloudEvent } from '@openfoundry/spi';
import type { ObjectEventData, LinkEventData } from '@openfoundry/engine';
import type { EventBus } from '@openfoundry/engine';
import type { AuthenticatedUserInfo } from '../graphql/types.js';

// ─── Types ───

/** A change event delivered to GraphQL subscribers. */
export interface ChangeEvent {
  changeType: 'CREATED' | 'UPDATED' | 'DELETED';
  object: { id: string; _type: string };
  previousValues: Record<string, { old: unknown; new: unknown }> | null;
  causedBy: { actionType: string | null; actionId: string | null } | null;
  timestamp: string;
}

/** Filter criteria for foosChanged subscriptions. */
export interface SubscriptionFilter {
  [field: string]: unknown;
}

/** Result of authenticating a WebSocket connection. */
export type ConnectionAuthResult =
  | { authenticated: true; user: AuthenticatedUserInfo }
  | { authenticated: false; error: string };

/** Function that authenticates a WebSocket connection from connection params. */
export type ConnectionAuthenticator = (
  connectionParams: Record<string, unknown>,
) => Promise<ConnectionAuthResult>;

// ─── CloudEvent to ChangeEvent mapping ───

const OBJECT_EVENT_CHANGE_MAP: Record<string, ChangeEvent['changeType']> = {
  'openfoundry.object.created': 'CREATED',
  'openfoundry.object.updated': 'UPDATED',
  'openfoundry.object.deleted': 'DELETED',
};

const LINK_EVENT_TYPES: Set<string> = new Set([
  'openfoundry.link.created',
  'openfoundry.link.updated',
  'openfoundry.link.deleted',
]);

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Convert a CloudEvent with ObjectEventData into a ChangeEvent
 * and the topic it should be published to.
 */
export function mapObjectEvent(
  event: CloudEvent<ObjectEventData>,
): { topic: string; changeEvent: ChangeEvent } | null {
  const changeType = OBJECT_EVENT_CHANGE_MAP[event.type];
  if (!changeType || !event.data) return null;

  const data = event.data;
  const topic = `${lowerFirst(data.objectType)}Changed`;

  const changeEvent: ChangeEvent = {
    changeType,
    object: { id: data.objectId, _type: data.objectType },
    previousValues: data.changes ?? null,
    causedBy: data.causedBy
      ? {
          actionType: data.causedBy.actionType ?? null,
          actionId: data.causedBy.actionId ?? null,
        }
      : null,
    timestamp: event.time,
  };

  return { topic, changeEvent };
}

/**
 * Convert a CloudEvent with LinkEventData into ChangeEvents
 * for the related object types.  Link events trigger change
 * notifications on both endpoints.
 */
export function mapLinkEvent(
  event: CloudEvent<LinkEventData>,
): { topic: string; objectId: string }[] | null {
  if (!LINK_EVENT_TYPES.has(event.type) || !event.data) return null;

  const data = event.data;
  // A link event affects both endpoints.  The subject field is "LinkType/linkId"
  // and the data carries fromId and toId.  We produce generic notifications
  // for each end.  The consuming subscription resolvers will refetch the
  // objects to build the full ChangeEvent payloads.
  return [
    { topic: data.fromId, objectId: data.fromId },
    { topic: data.toId, objectId: data.toId },
  ];
}

// ─── Subscribable EventBus adapter ───

/**
 * Extends EventBus with a subscribe method so the subscription manager
 * can receive CloudEvents.
 */
export interface SubscribableEventBus extends EventBus {
  subscribe(handler: (event: CloudEvent) => void): () => void;
}

/**
 * In-memory subscribable event bus for testing and single-instance deploys.
 */
export class InMemorySubscribableEventBus implements SubscribableEventBus {
  public readonly events: CloudEvent[] = [];
  private handlers: Array<(event: CloudEvent) => void> = [];

  async publish(event: CloudEvent): Promise<void> {
    this.events.push(event);
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  subscribe(handler: (event: CloudEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler);
    };
  }

  clear(): void {
    this.events.length = 0;
  }
}

// ─── Subscription Manager ───

export interface SubscriptionManagerConfig {
  pubsub: PubSub;
  eventBus: SubscribableEventBus;
  authenticate: ConnectionAuthenticator;
}

/**
 * Manages the bridge between CloudEvents and GraphQL subscriptions.
 *
 * - Subscribes to the event bus for CloudEvents
 * - Maps them to ChangeEvent payloads
 * - Publishes to PubSub topics for GraphQL delivery
 * - Authenticates WebSocket connections
 */
export class SubscriptionManager {
  private readonly pubsub: PubSub;
  private readonly eventBus: SubscribableEventBus;
  private readonly authenticate: ConnectionAuthenticator;
  private unsubscribe: (() => void) | null = null;

  constructor(config: SubscriptionManagerConfig) {
    this.pubsub = config.pubsub;
    this.eventBus = config.eventBus;
    this.authenticate = config.authenticate;
  }

  /**
   * Start listening for CloudEvents and bridging them to PubSub.
   */
  start(): void {
    if (this.unsubscribe) return; // Already started

    this.unsubscribe = this.eventBus.subscribe((event: CloudEvent) => {
      this.handleCloudEvent(event);
    });
  }

  /**
   * Stop listening for CloudEvents.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Authenticate a WebSocket connection.
   * Called during the graphql-ws connection_init phase.
   */
  async authenticateConnection(
    connectionParams: Record<string, unknown>,
  ): Promise<ConnectionAuthResult> {
    return this.authenticate(connectionParams);
  }

  /**
   * Get the PubSub instance for use by subscription resolvers.
   */
  getPubSub(): PubSub {
    return this.pubsub;
  }

  // ─── Internal ───

  private handleCloudEvent(event: CloudEvent): void {
    // Handle object lifecycle events
    if (OBJECT_EVENT_CHANGE_MAP[event.type]) {
      const mapped = mapObjectEvent(event as CloudEvent<ObjectEventData>);
      if (mapped) {
        void this.pubsub.publish(mapped.topic, {
          [mapped.topic]: mapped.changeEvent,
        });
      }
      return;
    }

    // Handle link lifecycle events — emit change events for related objects
    if (LINK_EVENT_TYPES.has(event.type)) {
      const mappedLinks = mapLinkEvent(event as CloudEvent<LinkEventData>);
      if (mappedLinks) {
        for (const link of mappedLinks) {
          // Publish a minimal change notification; the subscription resolver
          // will refetch the full object if needed.
          const changeEvent: ChangeEvent = {
            changeType: 'UPDATED',
            object: { id: link.objectId, _type: 'unknown' },
            previousValues: null,
            causedBy: null,
            timestamp: event.time,
          };
          // Use a generic topic based on the objectId
          void this.pubsub.publish(link.topic, changeEvent);
        }
      }
    }
  }
}

// ─── Subscription resolver helpers ───

/**
 * Create a subscription resolver that filters by object ID.
 *
 * Used for `fooChanged(id: ID!)` subscriptions.
 */
export function createIdFilteredSubscription(
  pubsub: PubSub,
  topic: string,
): { subscribe: (_parent: unknown, args: { id: string }) => AsyncIterator<unknown> } {
  return {
    subscribe: (_parent: unknown, args: { id: string }) => {
      const baseIterator = pubsub.asyncIterator(topic);
      return filterAsyncIterator(baseIterator, (payload: unknown) => {
        const p = payload as Record<string, unknown>;
        const event = p[topic] as ChangeEvent | undefined;
        if (!event) return false;
        return event.object.id === args.id;
      });
    },
  };
}

/**
 * Create a subscription resolver for type-level changes with optional filter.
 *
 * Used for `foosChanged(filter: FooFilter)` subscriptions.
 */
export function createFilteredSubscription(
  pubsub: PubSub,
  topic: string,
): { subscribe: (_parent: unknown, args: { filter?: SubscriptionFilter }) => AsyncIterator<unknown> } {
  return {
    subscribe: (_parent: unknown, args: { filter?: SubscriptionFilter }) => {
      const baseIterator = pubsub.asyncIterator(topic);

      // If no filter, return all events for this type
      if (!args.filter || Object.keys(args.filter).length === 0) {
        return baseIterator;
      }

      // Filter events based on the filter criteria
      return filterAsyncIterator(baseIterator, (payload: unknown) => {
        const p = payload as Record<string, unknown>;
        const event = p[topic] as ChangeEvent | undefined;
        if (!event) return false;
        return matchesFilter(event, args.filter!);
      });
    },
  };
}

/**
 * Check if a ChangeEvent matches a subscription filter.
 * Matches on changeType if provided.
 */
function matchesFilter(event: ChangeEvent, filter: SubscriptionFilter): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (value == null) continue;

    if (key === 'changeType') {
      if (event.changeType !== value) return false;
      continue;
    }

    // Match on object fields when available
    const objField = (event.object as Record<string, unknown>)[key];
    if (objField !== undefined && objField !== value) return false;
  }
  return true;
}

/**
 * Wrap an AsyncIterator with a predicate filter.
 */
function filterAsyncIterator<T>(
  iterator: AsyncIterator<T>,
  predicate: (value: T) => boolean,
): AsyncIterator<T> {
  return {
    next(): Promise<IteratorResult<T>> {
      return new Promise((resolve, reject) => {
        const getNext = (): void => {
          iterator.next().then(
            (result) => {
              if (result.done) {
                resolve(result);
                return;
              }
              if (predicate(result.value)) {
                resolve(result);
              } else {
                getNext();
              }
            },
            (err) => reject(err),
          );
        };
        getNext();
      });
    },
    return: iterator.return
      ? (value?: unknown) => iterator.return!(value)
      : undefined,
    throw: iterator.throw
      ? (err?: unknown) => iterator.throw!(err)
      : undefined,
  } as AsyncIterator<T>;
}
