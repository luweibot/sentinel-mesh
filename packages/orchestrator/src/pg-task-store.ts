import type { QueryExecutor } from "@sentinel-mesh/database";
import type { AgentTask, AgentTaskResult } from "@sentinel-mesh/contracts";
import type { TaskRecord, TaskStore, TaskStatus } from "./task-store.js";

/**
 * Postgres-backed task store (agent_tasks table, migration 005).
 * The whole task payload and result are stored as JSONB; status bookkeeping
 * columns drive the tick scans.
 */
export class PgTaskStore implements TaskStore {
  constructor(private readonly executor: QueryExecutor) {}

  async save(record: TaskRecord): Promise<void> {
    await this.executor.query(
      `insert into agent_tasks
         (task_id, agent_id, task_type, status, attempt_executed, idempotency_key,
          workflow_run_id, deadline_at, retry_at, task, result, issued_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       on conflict (task_id) do update set
         status = excluded.status,
         attempt_executed = excluded.attempt_executed,
         retry_at = excluded.retry_at,
         result = excluded.result,
         updated_at = now()`,
      [
        record.task.taskId,
        record.task.assignedAgentId,
        record.task.taskType,
        record.status,
        record.attemptExecuted,
        record.task.idempotencyKey ?? null,
        record.task.workflowRunId ?? null,
        record.task.deadlineAt ?? null,
        record.retryAt ?? null,
        JSON.stringify(record.task),
        record.result ? JSON.stringify(record.result) : null,
        record.task.issuedAt,
      ],
    );
  }

  private rowToRecord(row: Record<string, unknown>): TaskRecord {
    return {
      task: JSON.parse(String(row["task"])) as AgentTask,
      status: String(row["status"]) as TaskStatus,
      attemptExecuted: Number(row["attempt_executed"] ?? 0),
      retryAt: row["retry_at"] ? new Date(String(row["retry_at"])).toISOString() : undefined,
      result: row["result"] ? (JSON.parse(String(row["result"])) as AgentTaskResult) : undefined,
      updatedAt: row["updated_at"] ? new Date(String(row["updated_at"])).toISOString() : "",
    };
  }

  async find(taskId: string): Promise<TaskRecord | undefined> {
    const result = await this.executor.query("select * from agent_tasks where task_id = $1", [taskId]);
    const row = result.rows[0];
    return row ? this.rowToRecord(row) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<TaskRecord | undefined> {
    const result = await this.executor.query(
      "select * from agent_tasks where idempotency_key = $1",
      [key],
    );
    const row = result.rows[0];
    return row ? this.rowToRecord(row) : undefined;
  }

  async listByStatuses(statuses: TaskStatus[]): Promise<TaskRecord[]> {
    const result = await this.executor.query(
      "select * from agent_tasks where status = any($1) order by issued_at",
      [statuses],
    );
    return result.rows.map((row) => this.rowToRecord(row));
  }

  async findByWorkflowRun(runId: string): Promise<TaskRecord[]> {
    const result = await this.executor.query(
      "select * from agent_tasks where workflow_run_id = $1 order by issued_at",
      [runId],
    );
    return result.rows.map((row) => this.rowToRecord(row));
  }
}
