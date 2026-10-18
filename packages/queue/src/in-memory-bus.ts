import type { EventEnvelope } from "@sentinel-mesh/contracts";
import type { EventPublisher, EventSubscriber, EventSubscription } from "./types.js";

/**
 * Deterministic in-process event bus for development and tests.
 *
 * Semantics:
 *  - Handlers are invoked sequentially in subscription order (determinism).
 *  - A failing handler does not prevent later handlers from running.
 *  - After all handlers have run, publish() rethrows the first error, or an
 *    AggregateError when several handlers failed.
 *  - Every published envelope is retained in `published` for assertions and
 *    debugging. (Not suitable for production volumes by design.)
 */
export class InMemoryEventBus implements EventPublisher, EventSubscriber {
  readonly mode = "in-memory" as const;
  readonly published: EventEnvelope[] = [];
  private readonly handlers = new Set<(envelope: EventEnvelope) => Promise<void>>();

  async publish(envelope: EventEnvelope): Promise<void> {
    this.published.push(envelope);
    const errors: unknown[] = [];
    for (const handler of [...this.handlers]) {
      try {
        await handler(envelope);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "multiple event handlers failed");
    }
  }

  async subscribe(handler: (envelope: EventEnvelope) => Promise<void>): Promise<EventSubscription> {
    this.handlers.add(handler);
    return {
      dispose: async () => {
        this.handlers.delete(handler);
      },
    };
  }
}
