/**
 * EventBus interface — abstract transport for CloudEvents.
 * Concrete implementations (RedPanda, Kafka, in-memory) provided separately.
 */

import type { CloudEvent } from '@openfoundry/spi';

/**
 * Abstract event bus that receives CloudEvents for delivery.
 * Implementations handle routing to Kafka, RedPanda, or in-memory subscribers.
 */
export interface EventBus {
  /** Publish a CloudEvent to the bus. */
  publish(event: CloudEvent): Promise<void>;
}

/**
 * In-memory EventBus for testing. Collects all published events.
 */
export class InMemoryEventBus implements EventBus {
  public readonly events: CloudEvent[] = [];

  async publish(event: CloudEvent): Promise<void> {
    this.events.push(event);
  }

  /** Clear all collected events. */
  clear(): void {
    this.events.length = 0;
  }
}
