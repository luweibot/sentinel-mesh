import type { EventEnvelope } from "@sentinel-mesh/contracts";
import { parseEnvelope } from "@sentinel-mesh/contracts";
import { InMemoryEventBus } from "./in-memory-bus.js";
import type { EventBusMode, EventPublisher } from "./types.js";

export * from "./types.js";
export { InMemoryEventBus } from "./in-memory-bus.js";

export interface CreatePublisherOptions {
  /** When unset, the deterministic in-memory bus is used. */
  redisUrl?: string;
  queueName?: string;
}

/**
 * Factory used by services at startup.
 *
 * Default (no REDIS_URL): the in-memory bus, which makes local development
 * deterministic and dependency-free. With REDIS_URL set: the BullMQ
 * publisher. The BullMQ module is imported dynamically so the default path
 * never loads ioredis or opens sockets.
 *
 * Both publishers validate the envelope shape before dispatch.
 */
export async function createEventPublisher(options: CreatePublisherOptions): Promise<EventPublisher> {
  if (!options.redisUrl) {
    return new InMemoryEventBus();
  }
  const { BullMqEventPublisher } = await import("./bullmq-publisher.js");
  const publisher = new BullMqEventPublisher({
    redisUrl: options.redisUrl,
    queueName: options.queueName,
  });
  return {
    async publish(envelope: EventEnvelope): Promise<void> {
      // Validate before handing to BullMQ so bad envelopes fail fast
      // regardless of the transport.
      parseEnvelope(envelope);
      await publisher.publish(envelope);
    },
    mode: "bullmq" satisfies EventBusMode,
  } as EventPublisher;
}

export function busMode(publisher: EventPublisher): EventBusMode {
  if (publisher instanceof InMemoryEventBus) {
    return "in-memory";
  }
  if ("mode" in publisher && (publisher as { mode?: EventBusMode }).mode === "bullmq") {
    return "bullmq";
  }
  return "in-memory";
}
