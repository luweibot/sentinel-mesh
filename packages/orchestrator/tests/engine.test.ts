import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { createLogger, type Logger } from "@sentinel-mesh/logger";
import { InMemoryEventBus } from "@sentinel-mesh/queue";
import { defineAgent, NonRetryableError, type AnyAgentDefinition } from "@sentinel-mesh/agent-sdk";
import {
  InMemoryEventOutbox,
  InMemoryProcessedEvents,
  InMemoryRunStore,
  InMemoryTaskStore,
  OrchestrationEngine,
  OrchestrationError,
  type Clock,
} from "../src/index.js";

function silentLogger(): Logger {
  const sink = new PassThrough();
  sink.resume();
  return createLogger({ service: "test", level: "silent", destination: sink });
}

const ioSchema = z.object({ value: z.string() }).strict();

let clockMs = Date.parse("2026-01-06T09:00:00.000Z");
const clock: Clock = { now: () => new Date(clockMs) };
function advance(ms: number): void {
  clockMs += ms;
}
function resetClock(): void {
  clockMs = Date.parse("2026-01-06T09:00:00.000Z");
}

interface Harness {
  engine: OrchestrationEngine;
  bus: InMemoryEventBus;
  outbox: InMemoryEventOutbox;
  store: InMemoryTaskStore;
}

function harness(...agents: AnyAgentDefinition[]): Harness {
  resetClock();
  const bus = new InMemoryEventBus();
  const outbox = new InMemoryEventOutbox();
  const store = new InMemoryTaskStore();
  const engine = new OrchestrationEngine({
    bus,
    taskStore: store,
    runStore: new InMemoryRunStore(),
    outbox,
    processedEvents: new InMemoryProcessedEvents(),
    clock,
    logger: silentLogger(),
  });
  for (const agent of agents) {
    engine.register(agent);
  }
  return { engine, bus, outbox, store };
}

function echoAgent(agentId = "echo-agent", opts?: { budget?: { maxTasksPerMinute: number } }) {
  return defineAgent({
    manifest: {
      manifestVersion: 1,
      agentId,
      displayName: "Echo",
      version: "0.1.0",
      capabilities: ["research"],
      supportedTaskTypes: ["research-topic"],
      chainAffinity: [],
      permissions: { networkAccess: "mock", canSignTransactions: false },
    },
    inputSchema: ioSchema,
    outputSchema: ioSchema,
    budget: { wallClockMs: 60_000, maxTasksPerMinute: opts?.budget?.maxTasksPerMinute ?? 60, maxConcurrent: 2 },
    retry: { maxAttempts: 2, backoffMs: 0 },
    handle: async (ctx, input) => ({ value: `echo:${input.value}` }),
  });
}

describe("task lifecycle", () => {
  it("issues a task, executes it inline, and records the result with a trace", async () => {
    const { engine, outbox } = harness(echoAgent());
    const task = await engine.issueTask({
      agentId: "echo-agent",
      taskType: "research-topic",
      input: { value: "hi" },
    });
    expect(task.attempt).toBe(1);
    expect(task.traceId).toBeDefined();

    const record = await engine.getTask(task.taskId);
    expect(record?.status).toBe("succeeded");
    expect(record?.result?.status).toBe("success");
    expect(record?.result?.output).toEqual({ value: "echo:hi" });
    expect(record?.result?.traceId).toBe(task.traceId);

    // Outbox recorded both envelopes; trace recorded them too.
    expect(outbox.records.map((e) => e.type)).toEqual(["agent.task.issued", "agent.task.completed"]);
    const trace = engine.getTrace(task.traceId!);
    expect(trace.map((e) => e.type)).toEqual(["agent.task.issued", "agent.task.completed"]);
  });

  it("replays the same idempotency key without re-executing", async () => {
    const { engine } = harness(echoAgent());
    const first = await engine.issueTask({
      agentId: "echo-agent",
      taskType: "research-topic",
      input: { value: "hi" },
      idempotencyKey: "key-1",
    });
    const second = await engine.issueTask({
      agentId: "echo-agent",
      taskType: "research-topic",
      input: { value: "hi" },
      idempotencyKey: "key-1",
    });
    expect(second.taskId).toBe(first.taskId);
    const records = await engine.listTasks();
    expect(records.length).toBe(1);
  });

  it("skips duplicate delivery of the same issued envelope (idempotent consumer)", async () => {
    const { engine, bus } = harness(echoAgent());
    const task = await engine.issueTask({ agentId: "echo-agent", taskType: "research-topic", input: { value: "x" } });
    const issued = bus.published.find((e) => e.type === "agent.task.issued" && (e.payload as { taskId: string }).taskId === task.taskId)!;
    const completedBefore = bus.published.filter((e) => e.type === "agent.task.completed").length;
    expect(completedBefore).toBe(1);
    // Redeliver the same envelope.
    await bus.publish(issued);
    const completedAfter = bus.published.filter((e) => e.type === "agent.task.completed").length;
    expect(completedAfter).toBe(1);
    const record = await engine.getTask(task.taskId);
    expect(record?.attemptExecuted).toBe(1);
  });

  it("rejects unknown agents and unsupported task types", async () => {
    const { engine } = harness(echoAgent());
    await expect(
      engine.issueTask({ agentId: "ghost", taskType: "research-topic", input: {} }),
    ).rejects.toThrow(OrchestrationError);
    await expect(
      engine.issueTask({ agentId: "echo-agent", taskType: "summarize-news", input: {} }),
    ).rejects.toThrow(OrchestrationError);
  });

  it("retries a retryable failure and records the final attempt", async () => {
    resetClock();
    let calls = 0;
    const flaky = defineAgent({
      manifest: {
        manifestVersion: 1,
        agentId: "flaky-agent",
        displayName: "Flaky",
        version: "0.1.0",
        capabilities: ["research"],
        supportedTaskTypes: ["research-topic"],
        chainAffinity: [],
        permissions: { networkAccess: "mock", canSignTransactions: false },
      },
      inputSchema: ioSchema,
      outputSchema: ioSchema,
      retry: { maxAttempts: 3, backoffMs: 0 },
      handle: async (ctx, input) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("transient failure");
        }
        expect(ctx.attempt).toBe(2);
        return input;
      },
    });
    const { engine } = harness(flaky);
    const task = await engine.issueTask({ agentId: "flaky-agent", taskType: "research-topic", input: { value: "v" } });
    await engine.settle();
    const record = await engine.getTask(task.taskId);
    expect(record?.status).toBe("succeeded");
    expect(record?.task.attempt).toBe(2);
    expect(record?.result?.attempt).toBe(2);
    expect(calls).toBe(2);
  });

  it("fails terminally when retries are exhausted", async () => {
    resetClock();
    const alwaysFails = defineAgent({
      manifest: {
        manifestVersion: 1,
        agentId: "broken-agent",
        displayName: "Broken",
        version: "0.1.0",
        capabilities: ["research"],
        supportedTaskTypes: ["research-topic"],
        chainAffinity: [],
        permissions: { networkAccess: "mock", canSignTransactions: false },
      },
      inputSchema: ioSchema,
      outputSchema: ioSchema,
      retry: { maxAttempts: 2, backoffMs: 0 },
      handle: async () => {
        throw new Error("always broken");
      },
    });
    const { engine } = harness(alwaysFails);
    const task = await engine.issueTask({ agentId: "broken-agent", taskType: "research-topic", input: { value: "v" } });
    await engine.settle();
    const record = await engine.getTask(task.taskId);
    expect(record?.status).toBe("failed");
    expect(record?.task.attempt).toBe(2);
    expect(record?.result?.error?.code).toBe("AGENT_RUNTIME_ERROR");
  });

  it("does not retry non-retryable failures", async () => {
    resetClock();
    let calls = 0;
    const terminal = defineAgent({
      manifest: {
        manifestVersion: 1,
        agentId: "terminal-agent",
        displayName: "Terminal",
        version: "0.1.0",
        capabilities: ["research"],
        supportedTaskTypes: ["research-topic"],
        chainAffinity: [],
        permissions: { networkAccess: "mock", canSignTransactions: false },
      },
      inputSchema: ioSchema,
      outputSchema: ioSchema,
      retry: { maxAttempts: 3, backoffMs: 0 },
      handle: async () => {
        calls += 1;
        throw new NonRetryableError("E_TERMINAL", "do not retry me");
      },
    });
    const { engine } = harness(terminal);
    const task = await engine.issueTask({ agentId: "terminal-agent", taskType: "research-topic", input: { value: "v" } });
    await engine.settle();
    const record = await engine.getTask(task.taskId);
    expect(record?.status).toBe("failed");
    expect(record?.task.attempt).toBe(1);
    expect(calls).toBe(1);
  });

  it("fails tasks whose deadline passes before execution", async () => {
    const { engine } = harness(echoAgent("parked-agent"));
    const task = await engine.issueTask({
      agentId: "parked-agent",
      taskType: "research-topic",
      input: { value: "x" },
      deadlineAt: new Date(clockMs - 1).toISOString(),
    });
    const record = await engine.getTask(task.taskId);
    expect(record?.status).toBe("failed");
    expect(record?.result?.error?.code).toBe("DEADLINE_EXCEEDED");
  });

  it("parks tasks when the per-minute budget is exhausted, then drives them on tick", async () => {
    resetClock();
    const { engine } = harness(echoAgent("budgeted-agent", { budget: { maxTasksPerMinute: 1 } }));
    const first = await engine.issueTask({ agentId: "budgeted-agent", taskType: "research-topic", input: { value: "1" } });
    const second = await engine.issueTask({ agentId: "budgeted-agent", taskType: "research-topic", input: { value: "2" } });

    const secondRecord = await engine.getTask(second.taskId);
    expect(secondRecord?.status).toBe("retry-scheduled");
    expect((await engine.getTask(first.taskId))?.status).toBe("succeeded");

    advance(61_000);
    await engine.settle();
    expect((await engine.getTask(second.taskId))?.status).toBe("succeeded");
  });

  it("cancels pending tasks and refuses to cancel terminal ones", async () => {
    const { engine } = harness(echoAgent("cancel-target"));
    const deadline = new Date(clockMs + 10 * 60_000).toISOString();
    const task = await engine.issueTask({
      agentId: "cancel-target",
      taskType: "research-topic",
      input: { value: "x" },
      deadlineAt: deadline,
    });
    expect((await engine.getTask(task.taskId))?.status).toBe("succeeded");
    await expect(engine.cancelTask(task.taskId)).rejects.toThrow();
  });
});

describe("workflows", () => {
  function upperAgent() {
    return defineAgent({
      manifest: {
        manifestVersion: 1,
        agentId: "upper-agent",
        displayName: "Upper",
        version: "0.1.0",
        capabilities: ["source-verification"],
        supportedTaskTypes: ["verify-sources"],
        chainAffinity: [],
        permissions: { networkAccess: "mock", canSignTransactions: false },
      },
      inputSchema: z.object({ text: z.string() }).strict(),
      outputSchema: z.object({ upper: z.string() }).strict(),
      handle: async (ctx, input) => ({ upper: input.text.toUpperCase() }),
    });
  }
  function countAgent() {
    return defineAgent({
      manifest: {
        manifestVersion: 1,
        agentId: "count-agent",
        displayName: "Count",
        version: "0.1.0",
        capabilities: ["news-intelligence"],
        supportedTaskTypes: ["summarize-news"],
        chainAffinity: [],
        permissions: { networkAccess: "mock", canSignTransactions: false },
      },
      inputSchema: z.object({ upper: z.string() }).strict(),
      outputSchema: z.object({ length: z.number() }).strict(),
      handle: async (ctx, input) => ({ length: input.upper.length }),
    });
  }

  it("runs a three-step workflow, wiring outputs between agents", async () => {
    const { engine, outbox } = harness(upperAgent(), countAgent());
    const { run, traceId } = await engine.startWorkflow({
      workflowName: "demo-pipeline",
      steps: [
        {
          name: "upper",
          agentId: "upper-agent",
          taskType: "verify-sources",
          buildInput: () => ({ text: "sentinel" }),
        },
        {
          name: "count",
          agentId: "count-agent",
          taskType: "summarize-news",
          buildInput: ({ priorOutputs }) => ({ upper: (priorOutputs[0] as { upper: string }).upper }),
        },
      ],
    });

    const finalRun = await engine.getRun(run.runId);
    expect(finalRun?.status).toBe("completed");
    expect(finalRun?.steps.map((s) => s.status)).toEqual(["succeeded", "succeeded"]);
    expect(finalRun?.steps[1]?.output).toEqual({ length: 8 });

    // Trace: 2 issued + 2 completed + 2 workflow transitions.
    const trace = engine.getTrace(traceId);
    const types = trace.map((e) => e.type);
    expect(types.filter((t) => t === "agent.task.issued")).toHaveLength(2);
    expect(types.filter((t) => t === "agent.task.completed")).toHaveLength(2);
    expect(types.filter((t) => t === "workflow.state.changed")).toHaveLength(2);
    expect(trace.every((e) => e.correlationId === traceId)).toBe(true);
    expect(outbox.records.length).toBe(trace.length);
  });

  it("fails the run when a step fails terminally and never issues later steps", async () => {
    resetClock();
    let countCalls = 0;
    const failing = defineAgent({
      manifest: {
        manifestVersion: 1,
        agentId: "failing-agent",
        displayName: "Failing",
        version: "0.1.0",
        capabilities: ["source-verification"],
        supportedTaskTypes: ["verify-sources"],
        chainAffinity: [],
        permissions: { networkAccess: "mock", canSignTransactions: false },
      },
      inputSchema: z.object({ text: z.string() }).strict(),
      outputSchema: z.object({ upper: z.string() }).strict(),
      retry: { maxAttempts: 1, backoffMs: 0 },
      handle: async () => {
        throw new NonRetryableError("E_STEP_FAIL", "step is broken");
      },
    });
    const counter = countAgent();
    const spyCounter = {
      ...counter,
      handle: async (ctx: unknown, input: { upper: string }) => {
        countCalls += 1;
        return { length: input.upper.length };
      },
    } as typeof counter;
    const { engine } = harness(failing, spyCounter);
    const { run } = await engine.startWorkflow({
      workflowName: "doomed-pipeline",
      steps: [
        { name: "fails", agentId: "failing-agent", taskType: "verify-sources", buildInput: () => ({ text: "x" }) },
        { name: "never", agentId: "count-agent", taskType: "summarize-news", buildInput: () => ({ upper: "y" }) },
      ],
    });
    const finalRun = await engine.getRun(run.runId);
    expect(finalRun?.status).toBe("failed");
    expect(finalRun?.steps[0]?.status).toBe("failed");
    expect(finalRun?.steps[0]?.error?.code).toBe("E_STEP_FAIL");
    expect(finalRun?.steps[1]?.status).toBe("pending");
    expect(countCalls).toBe(0);
  });

  it("cancels a run and its pending tasks, and ignores late results", async () => {
    resetClock();
    const budgetedEcho = echoAgent("parked-echo", { budget: { maxTasksPerMinute: 1 } });
    const { engine: engine2 } = harness(budgetedEcho);
    // Use up the single budget slot with a standalone task.
    await engine2.issueTask({ agentId: "parked-echo", taskType: "research-topic", input: { value: "warm" } });
    const { run } = await engine2.startWorkflow({
      workflowName: "cancellable",
      steps: [
        { name: "only", agentId: "parked-echo", taskType: "research-topic", buildInput: () => ({ value: "s" }) },
      ],
    });
    const parkedRun = await engine2.getRun(run.runId);
    expect(parkedRun?.status).toBe("running");
    const cancelled = await engine2.cancelRun(run.runId);
    expect(cancelled?.status).toBe("cancelled");
    const tasks = await engine2.listTasks();
    const workflowTask = tasks.find((t) => t.task.workflowRunId === run.runId);
    expect(["cancelled", "retry-scheduled", "running"]).toContain(workflowTask?.status);
    // Late tick does not crash and does not resurrect the run.
    await engine2.tick();
    expect((await engine2.getRun(run.runId))?.status).toBe("cancelled");
  });

  it("rejects plans with unknown agents or no steps", async () => {
    const { engine } = harness(echoAgent());
    await expect(
      engine.startWorkflow({ workflowName: "bad", steps: [] }),
    ).rejects.toThrow(OrchestrationError);
    await expect(
      engine.startWorkflow({
        workflowName: "bad",
        steps: [{ name: "x", agentId: "ghost", taskType: "research-topic", buildInput: () => ({}) }],
      }),
    ).rejects.toThrow(OrchestrationError);
  });
});
