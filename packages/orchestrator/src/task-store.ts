import { z } from "zod";
import type { AgentTask, AgentTaskResult } from "@sentinel-mesh/contracts";

/**
 * Durable task storage.
 *
 * A TaskRecord is the orchestrator's persistence unit: the immutable task
 * payload plus execution bookkeeping (status, attempt progress, retry
 * schedule, and the terminal result).
 *
 * Two implementations exist: InMemoryTaskStore (deterministic dev/test) and
 * PgTaskStore (Postgres, upsert into the agent_tasks table created by
 * migration 005).
 */

export const TaskStatus = z.enum([
  "pending",
  "running",
  "retry-scheduled",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export interface TaskRecord {
  task: AgentTask;
  status: TaskStatus;
  /** Highest attempt number that has started execution. */
  attemptExecuted: number;
  /** Earliest time a retry-scheduled task may be re-issued. */
  retryAt?: string;
  result?: AgentTaskResult;
  updatedAt: string;
}

export interface TaskStore {
  save(record: TaskRecord): Promise<void>;
  find(taskId: string): Promise<TaskRecord | undefined>;
  findByIdempotencyKey(key: string): Promise<TaskRecord | undefined>;
  listByStatuses(statuses: TaskStatus[]): Promise<TaskRecord[]>;
  findByWorkflowRun(runId: string): Promise<TaskRecord[]>;
}

export class InMemoryTaskStore implements TaskStore {
  private readonly records = new Map<string, TaskRecord>();

  async save(record: TaskRecord): Promise<void> {
    this.records.set(record.task.taskId, { ...record });
  }

  async find(taskId: string): Promise<TaskRecord | undefined> {
    const record = this.records.get(taskId);
    return record ? { ...record } : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<TaskRecord | undefined> {
    const record = [...this.records.values()].find((r) => r.task.idempotencyKey === key);
    return record ? { ...record } : undefined;
  }

  async listByStatuses(statuses: TaskStatus[]): Promise<TaskRecord[]> {
    return [...this.records.values()]
      .filter((record) => statuses.includes(record.status))
      .sort((a, b) => a.task.issuedAt.localeCompare(b.task.issuedAt))
      .map((record) => ({ ...record }));
  }

  async findByWorkflowRun(runId: string): Promise<TaskRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.task.workflowRunId === runId)
      .map((record) => ({ ...record }));
  }
}
