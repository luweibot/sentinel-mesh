import { z } from "zod";
import {
  AgentManifest,
  validateManifestCoherence,
  type AgentTask,
} from "@sentinel-mesh/contracts";
import type { Logger } from "@sentinel-mesh/logger";

/**
 * Agent SDK: definition and execution harness.
 *
 * Agents are declared with `defineAgent`, which validates the manifest and
 * budget/retry settings up front, and executed with `executeTask`, a hardened
 * harness that enforces (in order):
 *
 *  1. Input validation against the agent's Zod schema (strict).
 *  2. Cancellation (cooperative signal, checked before and after the handler).
 *  3. Deadlines (checked before the run, and again after: late output is
 *     discarded, not accepted).
 *  4. Wall-clock budgets (cooperative ctx.isOverBudget() plus a post-run
 *     check; over-budget output is discarded).
 *  5. Output validation against the agent's Zod schema (strict).
 *
 * Error classification: handler-thrown NonRetryableError is terminal; anything
 * else is retryable and the orchestrator decides whether to retry.
 */

export class NonRetryableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export interface CancelSignal {
  readonly cancelled: boolean;
  readonly reason?: string;
}

/** Cooperative cancellation state shared between orchestrator and handler. */
export class CancelState implements CancelSignal {
  private _cancelled = false;
  private _reason: string | undefined;

  get cancelled(): boolean {
    return this._cancelled;
  }

  get reason(): string | undefined {
    return this._reason;
  }

  cancel(reason: string): void {
    if (!this._cancelled) {
      this._cancelled = true;
      this._reason = reason;
    }
  }
}

export interface AgentContext {
  readonly taskId: string;
  readonly agentId: string;
  readonly traceId?: string;
  readonly attempt: number;
  readonly deadlineAt?: string;
  /** Wall clock; injectable for deterministic tests. */
  now(): Date;
  /** Long handlers should poll this and bail out early. */
  isOverBudget(): boolean;
  readonly signal: CancelSignal;
  readonly logger: Logger;
}

export interface AgentBudget {
  /** Max wall-clock time for one attempt, ms. Over-budget output is discarded. */
  wallClockMs: number;
  /** Rolling one-minute task start cap enforced by the orchestrator. */
  maxTasksPerMinute: number;
  /** Max simultaneous executions of this agent. */
  maxConcurrent: number;
}

export interface RetryPolicy {
  /** Total attempts (1 = no retries). */
  maxAttempts: number;
  /** Fixed delay between attempts in ms. No jitter: determinism by design. */
  backoffMs: number;
}

export interface AgentDefinition<I = unknown, O = unknown> {
  readonly manifest: AgentManifest;
  readonly inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  readonly outputSchema: z.ZodType<O, z.ZodTypeDef, unknown>;
  readonly budget: AgentBudget;
  readonly retry: RetryPolicy;
  handle(ctx: AgentContext, input: I): Promise<O>;
}

/** Type-erased definition used by registries and the orchestrator. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentDefinition = AgentDefinition<any, any>;

export const DEFAULT_BUDGET: AgentBudget = {
  wallClockMs: 10_000,
  maxTasksPerMinute: 60,
  maxConcurrent: 2,
};

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 2,
  backoffMs: 100,
};

export class AgentDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDefinitionError";
  }
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AgentDefinitionError(`${name} must be a positive integer, got ${value}`);
  }
}

export interface DefineAgentSpec<I, O> {
  /** Raw manifest; validated with AgentManifest (strict) plus coherence rules. */
  manifest: unknown;
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  outputSchema: z.ZodType<O, z.ZodTypeDef, unknown>;
  budget?: Partial<AgentBudget>;
  retry?: Partial<RetryPolicy>;
  handle: (ctx: AgentContext, input: I) => Promise<O>;
}

/** Declare a typed agent. Throws on invalid manifest, budget, or retry policy. */
export function defineAgent<I, O>(spec: DefineAgentSpec<I, O>): AgentDefinition<I, O> {
  const manifest = AgentManifest.parse(spec.manifest);
  const problems = validateManifestCoherence(manifest);
  if (problems.length > 0) {
    throw new AgentDefinitionError(`incoherent manifest for '${manifest.agentId}': ${problems.join("; ")}`);
  }
  const budget: AgentBudget = { ...DEFAULT_BUDGET, ...spec.budget };
  assertPositiveInt("budget.wallClockMs", budget.wallClockMs);
  assertPositiveInt("budget.maxTasksPerMinute", budget.maxTasksPerMinute);
  assertPositiveInt("budget.maxConcurrent", budget.maxConcurrent);
  const retry: RetryPolicy = { ...DEFAULT_RETRY, ...spec.retry };
  assertPositiveInt("retry.maxAttempts", retry.maxAttempts);
  if (!Number.isInteger(retry.backoffMs) || retry.backoffMs < 0) {
    throw new AgentDefinitionError("retry.backoffMs must be a non-negative integer");
  }
  return {
    manifest,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    budget,
    retry,
    handle: spec.handle,
  };
}

// ---------------------------------------------------------------------------
// Task harness
// ---------------------------------------------------------------------------

export const TASK_ERROR_CODES = {
  inputInvalid: "INPUT_INVALID",
  outputInvalid: "OUTPUT_INVALID",
  cancelled: "TASK_CANCELLED",
  deadlineExceeded: "DEADLINE_EXCEEDED",
  budgetExceeded: "BUDGET_EXCEEDED",
  runtimeError: "AGENT_RUNTIME_ERROR",
} as const;

export interface TaskOutcome {
  status: "success" | "failed";
  output?: unknown;
  error?: { code: string; message: string };
  /** True when the orchestrator may retry the task. */
  retryable: boolean;
  startedAt: string;
  completedAt: string;
}

export interface ExecuteTaskDeps {
  now: () => Date;
  logger: Logger;
  /** Defaults to a fresh CancelState (nothing cancels it). */
  signal?: CancelSignal;
}

function summarizeZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

/** Run one attempt of a task through the hardened harness. */
export async function executeTask<I, O>(
  definition: AgentDefinition<I, O>,
  task: AgentTask,
  deps: ExecuteTaskDeps,
): Promise<TaskOutcome> {
  const startedAt = deps.now();
  const clockStart = startedAt.getTime();
  const signal = deps.signal ?? new CancelState();
  const ctx: AgentContext = {
    taskId: task.taskId,
    agentId: task.assignedAgentId,
    traceId: task.traceId,
    attempt: task.attempt,
    deadlineAt: task.deadlineAt,
    now: () => deps.now(),
    isOverBudget: () => deps.now().getTime() - clockStart > (task.budgetMs ?? definition.budget.wallClockMs),
    signal,
    logger: deps.logger,
  };

  const fail = (code: string, message: string, retryable: boolean): TaskOutcome => ({
    status: "failed",
    error: { code, message },
    retryable,
    startedAt: startedAt.toISOString(),
    completedAt: deps.now().toISOString(),
  });

  // 1. Input validation.
  let input: I;
  try {
    input = definition.inputSchema.parse(task.input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(TASK_ERROR_CODES.inputInvalid, `invalid task input: ${summarizeZodIssues(error)}`, false);
    }
    throw error;
  }

  // 2. Cancellation before start.
  if (signal.cancelled) {
    return fail(TASK_ERROR_CODES.cancelled, `task cancelled before execution: ${signal.reason ?? "no reason given"}`, false);
  }

  // 3. Deadline before start.
  const deadlineMs = task.deadlineAt ? Date.parse(task.deadlineAt) : undefined;
  if (deadlineMs !== undefined && deps.now().getTime() > deadlineMs) {
    return fail(TASK_ERROR_CODES.deadlineExceeded, "task deadline already passed before execution", false);
  }

  // 4. Run the handler.
  let output: O;
  try {
    output = await definition.handle(ctx, input);
  } catch (error) {
    if (error instanceof NonRetryableError) {
      return fail(error.code, error.message, false);
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail(TASK_ERROR_CODES.runtimeError, `agent handler failed: ${message}`, true);
  }

  // 5. Cancellation after the run: discard output.
  if (signal.cancelled) {
    return fail(TASK_ERROR_CODES.cancelled, `task cancelled during execution: ${signal.reason ?? "no reason given"}`, false);
  }

  // 6. Deadline after the run: late output is discarded.
  if (deadlineMs !== undefined && deps.now().getTime() > deadlineMs) {
    return fail(TASK_ERROR_CODES.deadlineExceeded, "handler completed after the deadline; output discarded", false);
  }

  // 7. Budget after the run: over-budget output is discarded.
  if (ctx.isOverBudget()) {
    return fail(TASK_ERROR_CODES.budgetExceeded, "handler exceeded its wall-clock budget; output discarded", false);
  }

  // 8. Output validation (strict schemas strip untrusted injected keys).
  let validated: O;
  try {
    validated = definition.outputSchema.parse(output);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(TASK_ERROR_CODES.outputInvalid, `agent produced invalid output: ${summarizeZodIssues(error)}`, false);
    }
    throw error;
  }

  return {
    status: "success",
    output: validated,
    retryable: false,
    startedAt: startedAt.toISOString(),
    completedAt: deps.now().toISOString(),
  };
}
