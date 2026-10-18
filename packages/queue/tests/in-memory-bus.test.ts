import { describe, expect, it } from "vitest";
import { createEnvelope, EventCatalog } from "@sentinel-mesh/contracts";
import { InMemoryEventBus } from "../src/index.js";

function envelope(eventId: string) {
  return createEnvelope(
    EventCatalog["signal.created"],
    {
      signalId: "9e1f0a1c-5b1e-4d7a-9a1a-6f4b5f0a1b2c",
      chain: "base",
      kind: "copy-trade",
      tokenIn: "0x1",
      tokenOut: "0x2",
      notionalUsdCents: 100,
    },
    { actor: { kind: "agent", id: "wallet-watcher" }, eventId, occurredAt: "2026-01-01T00:00:00.000Z" },
  );
}

describe("in-memory event bus", () => {
  it("delivers to handlers in subscription order and records published envelopes", async () => {
    const bus = new InMemoryEventBus();
    const order: string[] = [];
    await bus.subscribe(async () => {
      order.push("first");
    });
    await bus.subscribe(async () => {
      order.push("second");
    });
    const env = envelope("11111111-1111-4111-8111-111111111111");
    await bus.publish(env);
    expect(order).toEqual(["first", "second"]);
    expect(bus.published.map((e) => e.eventId)).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("runs all handlers even when one fails, then rethrows the first error", async () => {
    const bus = new InMemoryEventBus();
    const calls: string[] = [];
    await bus.subscribe(async () => {
      calls.push("a");
      throw new Error("handler a failed");
    });
    await bus.subscribe(async () => {
      calls.push("b");
    });
    await expect(bus.publish(envelope("22222222-2222-4222-8222-222222222222"))).rejects.toThrow("handler a failed");
    expect(calls).toEqual(["a", "b"]);
  });

  it("disposes subscriptions", async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    const subscription = await bus.subscribe(async (e) => {
      seen.push(e.eventId);
    });
    await bus.publish(envelope("33333333-3333-4333-8333-333333333333"));
    await subscription.dispose();
    await bus.publish(envelope("44444444-4444-4444-8444-444444444444"));
    expect(seen).toEqual(["33333333-3333-4333-8333-333333333333"]);
  });

  it("aggregates multiple handler failures", async () => {
    const bus = new InMemoryEventBus();
    await bus.subscribe(async () => {
      throw new Error("one");
    });
    await bus.subscribe(async () => {
      throw new Error("two");
    });
    await expect(bus.publish(envelope("55555555-5555-4555-8555-555555555555"))).rejects.toThrow(AggregateError);
  });
});
