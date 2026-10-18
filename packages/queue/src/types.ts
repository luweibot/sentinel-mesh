import type { EventEnvelope } from "@sentinel-mesh/contracts";

/** Publishes validated event envelopes onto the mesh's event stream. */
export interface EventPublisher {
  publish(envelope: EventEnvelope): Promise<void>;
}

export type EventHandler = (envelope: EventEnvelope) => Promise<void>;

export interface EventSubscription {
  dispose(): Promise<void>;
}

/** Subscribes to the event stream. Used by agents and projection workers. */
export interface EventSubscriber {
  subscribe(handler: EventHandler): Promise<EventSubscription>;
}

export type EventBusMode = "in-memory" | "bullmq";
