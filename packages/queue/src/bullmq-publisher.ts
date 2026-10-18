import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { EventEnvelope } from "@sentinel-mesh/contracts";
import type { EventPublisher } from "./types.js";

export interface BullMqPublisherOptions {
  redisUrl: string;
  /** Queue name. Defaults to "sentinel-mesh:events". */
  queueName?: string;
}

/**
 * Redis-backed publisher using BullMQ. The queue is created lazily so that
 * merely importing or constructing this class never opens a connection.
 *
 * jobId is set to the envelope's eventId: BullMQ deduplicates by job id, so
 * replays of the same envelope are dropped idempotently.
 */
export class BullMqEventPublisher implements EventPublisher {
  readonly mode = "bullmq" as const;
  private queue: Queue | undefined;

  constructor(private readonly options: BullMqPublisherOptions) {}

  private getQueue(): Queue {
    if (!this.queue) {
      const connection = new Redis(this.options.redisUrl, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
      });
      this.queue = new Queue(this.options.queueName ?? "sentinel-mesh:events", { connection });
    }
    return this.queue;
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    await this.getQueue().add(envelope.type, envelope, {
      jobId: envelope.eventId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
    });
  }

  async close(): Promise<void> {
    if (this.queue) {
      await this.queue.close();
      this.queue = undefined;
    }
  }
}
