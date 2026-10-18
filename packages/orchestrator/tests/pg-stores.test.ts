import { describe, expect, it } from "vitest";
import type { QueryResult } from "@sentinel-mesh/database";
import { PgEventOutbox, PgProcessedEvents, PgRunStore, PgTaskStore } from "../src/index.js";
import type { TaskRecord } from "../src/index.js";
import { AgentTask } from "@sentinel-mesh/contracts";

/**
 * Stateful fake executor: implements just enough of our SQL surface to
 * round-trip records. Assertions run against the actual upsert/select
 * statements, keeping the SQL honest without a live Postgres.
 */
class StatefulFakeExecutor {
  tasks = new Map<string, Record<string, unknown>>();
  processed = new Set<string>();
  outboxRows = new Map<string, Record<string, unknown>>();
  runDocs = new Map<string, Record<string, unknown>>();
  readonly executed: string[] = [];

  async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.executed.push(text);
    if (text.startsWith("insert into agent_tasks")) {
      const [taskId, agentId, taskType, status, attemptExecuted, , workflowRunId] = values ?? [];
      const prior = this.tasks.get(String(taskId)) ?? {};
      this.tasks.set(String(taskId), {
        ...prior,
        task_id: taskId,
        agent_id: agentId,
        task_type: taskType,
        status,
        attempt_executed: attemptExecuted,
        workflow_run_id: workflowRunId,
        task: (values as unknown[])[9],
        result: (values as unknown[])[10],
        issued_at: (values as unknown[])[11],
        updated_at: new Date().toISOString(),
      });
      return { rows: [] };
    }
    if (text.startsWith("select * from agent_tasks where task_id")) {
      const row = this.tasks.get(String((values ?? [])[0]));
      return { rows: row ? [row] : [] };
    }
    if (text.startsWith("select * from agent_tasks where status = any")) {
      const statuses = new Set((values ?? [[]])[0] as string[]);
      return { rows: [...this.tasks.values()].filter((row) => statuses.has(String(row["status"]))) };
    }
    if (text.startsWith("insert into processed_events")) {
      const key = `${(values ?? [])[1]}:${(values ?? [])[0]}`;
      if (this.processed.has(key)) {
        return { rows: [] };
      }
      this.processed.add(key);
      return { rows: [{ event_id: (values ?? [])[0] }] };
    }
    if (text.startsWith("insert into events_outbox")) {
      const eventId = String((values ?? [])[0]);
      this.outboxRows.set(eventId, { event_id: eventId, envelope: (values ?? [])[4] });
      return { rows: [] };
    }
    if (text.startsWith("select document from workflow_run_documents")) {
      const row = this.runDocs.get(String((values ?? [])[0]));
      return { rows: row ? [{ document: row["document"] }] : [] };
    }
    if (text.startsWith("insert into workflow_run_documents")) {
      this.runDocs.set(String((values ?? [])[0]), {
        run_id: (values ?? [])[0],
        document: (values ?? [])[2],
      });
      return { rows: [] };
    }
    throw new Error(`StatefulFakeExecutor: unhandled SQL: ${text.slice(0, 60)}`);
  }
}

function sampleRecord(): TaskRecord {
  const task = AgentTask.parse({
    schemaVersion: 1,
    taskId: "11111111-1111-4111-8111-111111111111",
    assignedAgentId: "research-agent",
    taskType: "research-topic",
    input: { topic: "test" },
    issuedAt: "2026-01-06T09:00:00.000Z",
    attempt: 1,
    traceId: "22222222-2222-4222-8222-222222222222",
    idempotencyKey: "idem-1",
  });
  return { task, status: "pending", attemptExecuted: 0, updatedAt: "2026-01-06T09:00:00.000Z" };
}

describe("Postgres stores (fake executor)", () => {
  it("task store upserts and round-trips records", async () => {
    const executor = new StatefulFakeExecutor();
    const store = new PgTaskStore(executor);
    const record = sampleRecord();
    await store.save(record);
    expect(executor.executed[0]).toContain("insert into agent_tasks");
    expect(executor.executed[0]).toContain("on conflict (task_id) do update");

    const found = await store.find(record.task.taskId);
    expect(found?.task.taskId).toBe(record.task.taskId);
    expect(found?.task.input).toEqual({ topic: "test" });
    expect(found?.status).toBe("pending");

    await store.save({ ...record, status: "succeeded", attemptExecuted: 1 });
    expect((await store.find(record.task.taskId))?.status).toBe("succeeded");
  });

  it("processed-event store claims each event once per consumer", async () => {
    const executor = new StatefulFakeExecutor();
    const store = new PgProcessedEvents(executor);
    expect(await store.markProcessed("consumer-a", "11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(await store.markProcessed("consumer-a", "11111111-1111-4111-8111-111111111111")).toBe(false);
    expect(await store.markProcessed("consumer-b", "11111111-1111-4111-8111-111111111111")).toBe(true);
  });

  it("event outbox records envelopes idempotently", async () => {
    const executor = new StatefulFakeExecutor();
    const outbox = new PgEventOutbox(executor);
    const envelope = {
      schemaVersion: 1 as const,
      eventId: "11111111-1111-4111-8111-111111111111",
      type: "agent.task.issued",
      occurredAt: "2026-01-06T09:00:00.000Z",
      actor: { kind: "system" as const, id: "test" },
      payload: {},
    };
    await outbox.record(envelope);
    await outbox.record(envelope);
    expect(executor.outboxRows.size).toBe(1);
    expect(executor.executed[0]).toContain("on conflict (event_id) do nothing");
  });

  it("run store round-trips workflow documents", async () => {
    const executor = new StatefulFakeExecutor();
    const store = new PgRunStore(executor);
    await store.save({
      schemaVersion: 1,
      runId: "33333333-3333-4333-8333-333333333333",
      workflowName: "research-collaboration",
      status: "running",
      input: { topic: "test" },
      createdAt: "2026-01-06T09:00:00.000Z",
      updatedAt: "2026-01-06T09:00:00.000Z",
      steps: [],
    });
    const found = await store.find("33333333-3333-4333-8333-333333333333");
    expect(found?.workflowName).toBe("research-collaboration");
    expect(found?.input).toEqual({ topic: "test" });
  });
});
