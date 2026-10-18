import { z } from "zod";
import { IsoDateTime, Slug, StructuredError, Uuid } from "./primitives.js";
import { TaskType } from "./agent-manifest.js";

/**
 * Task and result contracts.
 *
 * Work in the mesh flows through AgentTask -> (agent execution) -> AgentTaskResult.
 * Both schemas are versioned; the version travels with the payload so that
 * consumers can reject or route unknown versions explicitly.
 */

export const TaskPriority = z.enum(["low", "normal", "high"]);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const TASK_CONTRACT_VERSION = 1;

export const AgentTask = z
  .object({
    schemaVersion: z.literal(TASK_CONTRACT_VERSION),
    taskId: Uuid,
    assignedAgentId: Slug,
    taskType: TaskType,
    /** Task-type-specific input. Each task type defines its own input schema at the agent boundary. */
    input: z.unknown(),
    issuedAt: IsoDateTime,
    /** Soft deadline. Expired tasks fail with DEADLINE_EXCEEDED; the harness discards late output. */
    deadlineAt: IsoDateTime.optional(),
    priority: TaskPriority.default("normal"),
    /** Distributed trace id, shared by every event of a workflow. */
    traceId: Uuid.optional(),
    /** Caller-supplied idempotency key; the orchestrator deduplicates on it. */
    idempotencyKey: z.string().min(1).max(128).optional(),
    /** 1-based execution attempt. Retries increment it. */
    attempt: z.number().int().min(1).default(1),
    /** Present when the task belongs to a durable workflow run. */
    workflowRunId: Uuid.optional(),
    workflowStepId: Slug.optional(),
    /** Per-task wall-clock budget override (ms). */
    budgetMs: z.number().int().positive().optional(),
  })
  .strict();
export type AgentTask = z.infer<typeof AgentTask>;

export const TaskResultStatus = z.enum(["success", "failed"]);
export type TaskResultStatus = z.infer<typeof TaskResultStatus>;

export const AgentTaskResult = z
  .object({
    schemaVersion: z.literal(TASK_CONTRACT_VERSION),
    taskId: Uuid,
    agentId: Slug,
    status: TaskResultStatus,
    /** Result payload. Present on success (may be null when a task has no output). */
    output: z.unknown().optional(),
    traceId: Uuid.optional(),
    attempt: z.number().int().min(1).default(1),
    /** Required on failure, forbidden on success. */
    error: StructuredError.optional(),
    startedAt: IsoDateTime,
    completedAt: IsoDateTime,
  })
  .strict()
  .refine((result) => (result.status === "success" ? result.error === undefined : result.error !== undefined), {
    message: "failed results must include an error; successful results must not include one",
    path: ["error"],
  });
export type AgentTaskResult = z.infer<typeof AgentTaskResult>;
