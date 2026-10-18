import type { EventEnvelope } from "@sentinel-mesh/contracts";
import type { QueryExecutor } from "@sentinel-mesh/database";

/**
 * Idempotent consumers.
 *
 * Each consumer has a name; processed event ids are recorded per consumer so
 * redelivery (at-least-once transports) cannot double-process. Marking is
 * at-most-once per event: the id is claimed before the handler runs (a
 * crashing handler does not re-trigger side effects).
 */
export interface ProcessedEventStore {
  /** Returns true when this consumer had not seen the event (i.e. we won). */
  markProcessed(consumer: string, eventId: string): Promise<boolean>;
}

export class InMemoryProcessedEvents implements ProcessedEventStore {
  private readonly seen = new Map<string, Set<string>>();

  async markProcessed(consumer: string, eventId: string): Promise<boolean> {
    const set = this.seen.get(consumer) ?? new Set<string>();
    this.seen.set(consumer, set);
    if (set.has(eventId)) {
      return false;
    }
    set.add(eventId);
    return true;
  }
}

export class PgProcessedEvents implements ProcessedEventStore {
  constructor(private readonly executor: QueryExecutor) {}

  async markProcessed(consumer: string, eventId: string): Promise<boolean> {
    const result = await this.executor.query(
      `insert into processed_events (event_id, consumer)
       values ($1, $2)
       on conflict (event_id, consumer) do nothing
       returning event_id`,
      [eventId, consumer],
    );
    return result.rows.length > 0;
  }
}

export type EnvelopeHandler = (envelope: EventEnvelope) => Promise<void>;

/** Wrap a handler so a given consumer processes each event at most once. */
export function wrapIdempotent(
  consumer: string,
  store: ProcessedEventStore,
  handler: EnvelopeHandler,
  onSkip?: (envelope: EventEnvelope) => void,
): EnvelopeHandler {
  return async (envelope: EventEnvelope) => {
    const won = await store.markProcessed(consumer, envelope.eventId);
    if (!won) {
      onSkip?.(envelope);
      return;
    }
    await handler(envelope);
  };
}
