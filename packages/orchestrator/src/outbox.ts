import type { EventEnvelope } from "@sentinel-mesh/contracts";
import type { EventPublisher } from "@sentinel-mesh/queue";
import type { QueryExecutor } from "@sentinel-mesh/database";

/**
 * Transactional outbox pattern (write-ahead record + delegate publish).
 *
 * Every envelope the orchestrator publishes is first recorded in the outbox,
 * then handed to the transport. If the transport loses the message, the
 * outbox still holds the authoritative record of what was emitted.
 * Postgres: events_outbox (migration 001). In dev/test: in-memory array.
 */
export interface EventOutbox {
  record(envelope: EventEnvelope): Promise<void>;
}

export class InMemoryEventOutbox implements EventOutbox {
  readonly records: EventEnvelope[] = [];

  async record(envelope: EventEnvelope): Promise<void> {
    this.records.push(envelope);
  }
}

export class PgEventOutbox implements EventOutbox {
  constructor(private readonly executor: QueryExecutor) {}

  async record(envelope: EventEnvelope): Promise<void> {
    await this.executor.query(
      `insert into events_outbox (event_id, event_type, occurred_at, actor, envelope)
       values ($1, $2, $3, $4, $5)
       on conflict (event_id) do nothing`,
      [
        envelope.eventId,
        envelope.type,
        envelope.occurredAt,
        JSON.stringify(envelope.actor),
        JSON.stringify(envelope),
      ],
    );
  }
}

/** Records every envelope in the outbox before delegating to the transport. */
export class OutboxPublisher implements EventPublisher {
  constructor(
    private readonly transport: EventPublisher,
    private readonly outbox: EventOutbox,
  ) {}

  async publish(envelope: EventEnvelope): Promise<void> {
    await this.outbox.record(envelope);
    await this.transport.publish(envelope);
  }
}
