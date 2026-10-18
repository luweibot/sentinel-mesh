import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { z } from "zod";
import {
  AgentDefinitionError,
  CancelState,
  NonRetryableError,
  defineAgent,
  executeTask,
  TASK_ERROR_CODES,
} from "../src/index.js";
import { createLogger } from "@sentinel-mesh/logger";
import type { Logger } from "@sentinel-mesh/logger";
import type { AgentTask } from "@sentinel-mesh/contracts";

const manifest = {
  manifestVersion: 1,
  agentId: "echo-agent",
  displayName: "Echo",
  version: "0.1.0",
  capabilities: ["research"],
  supportedTaskTypes: ["research-topic"],
  chainAffinity: [],
  permissions: { networkAccess: "mock", canSignTransactions: false },
};

const ioSchema = z.object({ value: z.string() }).strict();

let clockMs = Date.parse("2026-01-05T12:00:00.000Z");
const clock = () => new Date(clockMs);
function advance(ms: number): void {
  clockMs += ms;
}

function silentLogger(): Logger {
  const sink = new PassThrough();
  sink.resume();
  return createLogger({ service: "test", level: "silent", destination: sink });
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    schemaVersion: 1,
    taskId: "11111111-1111-4111-8111-111111111111",
    assignedAgentId: "echo-agent",
    taskType: "research-topic",
    input: { value: "hi" },
    issuedAt: clock().toISOString(),
    attempt: 1,
    ...overrides,
  } as AgentTask;
}

describe("defineAgent", () => {
  it("validates the manifest and rejects signing claims", () => {
    expect(() =>
      defineAgent({
        manifest: { ...manifest, permissions: { networkAccess: "mock", canSignTransactions: true } },
        inputSchema: ioSchema,
        outputSchema: ioSchema,
        handle: async (ctx, input) => input,
      }),
    ).toThrow();
  });

  it("rejects incoherent manifest (capability without task type)", () => {
    expect(() =>
      defineAgent({
        manifest: { ...manifest, capabilities: ["research"], supportedTaskTypes: ["summarize-news"] },
        inputSchema: ioSchema,
        outputSchema: ioSchema,
        handle: async (ctx, input) => input,
      }),
    ).toThrow(AgentDefinitionError);
  });

  it("rejects non-positive budgets and retries", () => {
    for (const bad of [{ wallClockMs: 0 }, { maxTasksPerMinute: -1 }, { maxConcurrent: 0 }]) {
      expect(() =>
        defineAgent({
          manifest,
          inputSchema: ioSchema,
          outputSchema: ioSchema,
          budget: bad,
          handle: async (ctx, input) => input,
        }),
      ).toThrow(AgentDefinitionError);
    }
    expect(() =>
      defineAgent({
        manifest,
        inputSchema: ioSchema,
        outputSchema: ioSchema,
        retry: { maxAttempts: 0, backoffMs: 10 },
        handle: async (ctx, input) => input,
      }),
    ).toThrow(AgentDefinitionError);
  });
});

describe("executeTask harness", () => {
  it("runs a happy path and validates output", async () => {
    const def = defineAgent({
      manifest,
      inputSchema: ioSchema,
      outputSchema: ioSchema,
      handle: async (ctx, input) => {
        expect(ctx.attempt).toBe(1);
        return { value: `echo:${input.value}` };
      },
    });
    const outcome = await executeTask(def, task(), { now: clock, logger: silentLogger() });
    expect(outcome.status).toBe("success");
    expect(outcome.output).toEqual({ value: "echo:hi" });
    expect(outcome.retryable).toBe(false);
  });

  it("fails non-retryably on invalid input", async () => {
    const def = defineAgent({ manifest, inputSchema: ioSchema, outputSchema: ioSchema, handle: async (ctx, i) => i });
    const outcome = await executeTask(def, task({ input: { nope: true } }), { now: clock, logger: silentLogger() });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe(TASK_ERROR_CODES.inputInvalid);
    expect(outcome.retryable).toBe(false);
  });

  it("classifies generic handler errors as retryable", async () => {
    const def = defineAgent({
      manifest,
      inputSchema: ioSchema,
      outputSchema: ioSchema,
      handle: async () => {
        throw new Error("boom");
      },
    });
    const outcome = await executeTask(def, task(), { now: clock, logger: silentLogger() });
    expect(outcome.error?.code).toBe(TASK_ERROR_CODES.runtimeError);
    expect(outcome.retryable).toBe(true);
  });

  it("honors NonRetryableError with its custom code", async () => {
    const def = defineAgent({
      manifest,
      inputSchema: ioSchema,
      outputSchema: ioSchema,
      handle: async () => {
        throw new NonRetryableError("E_CUSTOM", "terminal problem");
      },
    });
    const outcome = await executeTask(def, task(), { now: clock, logger: silentLogger() });
    expect(outcome.error?.code).toBe("E_CUSTOM");
    expect(outcome.retryable).toBe(false);
  });

  it("fails before execution when the deadline already passed", async () => {
    const def = defineAgent({ manifest, inputSchema: ioSchema, outputSchema: ioSchema, handle: async (c, i) => i });
    const deadline = new Date(clockMs - 1).toISOString();
    const outcome = await executeTask(def, task({ deadlineAt: deadline }), { now: clock, logger: silentLogger() });
    expect(outcome.error?.code).toBe(TASK_ERROR_CODES.deadlineExceeded);
  });

  it("discards output when the handler finishes after the deadline", async () => {
    const def = defineAgent({
      manifest,
      inputSchema: ioSchema,
      outputSchema: ioSchema,
      handle: async (ctx, input) => {
        advance(5_000);
        return input;
      },
    });
    const deadline = new Date(clockMs + 1_000).toISOString();
    const outcome = await executeTask(def, task({ deadlineAt: deadline }), { now: clock, logger: silentLogger() });
    expect(outcome.error?.code).toBe(TASK_ERROR_CODES.deadlineExceeded);
    expect(outcome.output).toBeUndefined();
  });

  it("discards output when the handler exceeds its budget", async () => {
    const def = defineAgent({
      manifest,
      inputSchema: ioSchema,
      outputSchema: ioSchema,
      budget: { wallClockMs: 100, maxTasksPerMinute: 60, maxConcurrent: 1 },
      handle: async (ctx, input) => {
        advance(5_000);
        expect(ctx.isOverBudget()).toBe(true);
        return input;
      },
    });
    const outcome = await executeTask(def, task(), { now: clock, logger: silentLogger() });
    expect(outcome.error?.code).toBe(TASK_ERROR_CODES.budgetExceeded);
  });

  it("refuses to start a cancelled task and discards output cancelled mid-run", async () => {
    const signal = new CancelState();
    const immediate = defineAgent({
      manifest,
      inputSchema: ioSchema,
      outputSchema: ioSchema,
      handle: async (ctx, input) => {
        signal.cancel("run cancelled");
        return input;
      },
    });
    const cancelled = await executeTask(immediate, task(), { now: clock, logger: silentLogger(), signal });
    expect(cancelled.error?.code).toBe(TASK_ERROR_CODES.cancelled);
    expect(cancelled.output).toBeUndefined();
  });

  it("fails non-retryably when output violates the output schema", async () => {
    const def = defineAgent({
      manifest,
      inputSchema: ioSchema,
      outputSchema: ioSchema,
      handle: async () => ({ wrong: "shape" }) as unknown as { value: string },
    });
    const outcome = await executeTask(def, task(), { now: clock, logger: silentLogger() });
    expect(outcome.error?.code).toBe(TASK_ERROR_CODES.outputInvalid);
    expect(outcome.retryable).toBe(false);
  });
});
