import type { WorkflowRun } from "@sentinel-mesh/contracts";
import type { QueryExecutor } from "@sentinel-mesh/database";

/**
 * Durable workflow run storage. The full validated run document (including
 * steps) is stored as JSONB, updated on every transition. Postgres table:
 * workflow_run_documents (migration 005).
 */
export interface RunStore {
  save(run: WorkflowRun): Promise<void>;
  find(runId: string): Promise<WorkflowRun | undefined>;
  /** Most recent runs, newest first (dashboard listing). */
  recent(limit: number): Promise<WorkflowRun[]>;
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, WorkflowRun>();

  async save(run: WorkflowRun): Promise<void> {
    this.runs.set(run.runId, structuredClone(run));
  }

  async find(runId: string): Promise<WorkflowRun | undefined> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  async recent(limit: number): Promise<WorkflowRun[]> {
    return [...this.runs.values()]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit)
      .map((run: WorkflowRun) => structuredClone(run));
  }
}

export class PgRunStore implements RunStore {
  constructor(private readonly executor: QueryExecutor) {}

  async save(run: WorkflowRun): Promise<void> {
    await this.executor.query(
      `insert into workflow_run_documents (run_id, workflow_name, document, updated_at)
       values ($1, $2, $3, now())
       on conflict (run_id) do update set document = excluded.document, updated_at = now()`,
      [run.runId, run.workflowName, JSON.stringify(run)],
    );
  }

  async recent(limit: number): Promise<WorkflowRun[]> {
    const result = await this.executor.query(
      "select document from workflow_run_documents order by updated_at desc limit $1",
      [limit],
    );
    return (result.rows as unknown[]).map((row) => (row as { document: unknown }).document as WorkflowRun);
  }

  async find(runId: string): Promise<WorkflowRun | undefined> {
    const result = await this.executor.query(
      "select document from workflow_run_documents where run_id = $1",
      [runId],
    );
    const row = result.rows[0];
    return row ? (JSON.parse(String(row["document"])) as WorkflowRun) : undefined;
  }
}
