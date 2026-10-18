import { z } from "zod";
import { IsoDateTime, Slug, StructuredError, Uuid } from "./primitives.js";

/**
 * Durable workflow state contracts.
 *
 * A workflow run is a JSON-serializable state document. State lives in
 * Postgres (`workflow_runs` / `workflow_steps` tables, see packages/database
 * migrations) and is advanced by applying commands through the pure reducer in
 * `workflow-reducer.ts`. Because transitions are pure and validated, a run can
 * be restored after a crash and resumed from its persisted state.
 */

export const WORKFLOW_STATE_VERSION = 1;

export const WorkflowRunStatus = z.enum(["pending", "running", "waiting", "completed", "failed", "cancelled"]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;

export const WorkflowStepStatus = z.enum(["pending", "running", "waiting", "succeeded", "failed", "skipped", "cancelled"]);
export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatus>;

export const WorkflowStep = z
  .object({
    stepId: Slug,
    name: z.string().min(1),
    status: WorkflowStepStatus,
    startedAt: IsoDateTime.optional(),
    finishedAt: IsoDateTime.optional(),
    output: z.unknown().optional(),
    error: StructuredError.optional(),
  })
  .strict();
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const WorkflowRun = z
  .object({
    schemaVersion: z.literal(WORKFLOW_STATE_VERSION),
    runId: Uuid,
    workflowName: Slug,
    status: WorkflowRunStatus,
    input: z.unknown(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    finishedAt: IsoDateTime.optional(),
    steps: z.array(WorkflowStep),
  })
  .strict();
export type WorkflowRun = z.infer<typeof WorkflowRun>;
