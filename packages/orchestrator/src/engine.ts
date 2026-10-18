import { randomUUID } from "node:crypto";
import {
  EventCatalog,
  WorkflowTransitionError,
  applyWorkflowCommand,
  createEnvelope,
  createWorkflowRun,
  parseTypedEnvelope,
  AgentTask,
  type AgentTaskResult,
  type EventEnvelope,
  type TaskType,
  type WorkflowRun,
} from "@sentinel-mesh/contracts";
import {
  CancelState,
  executeTask,
  type AnyAgentDefinition,
} from "@sentinel-mesh/agent-sdk";
import type { Logger } from "@sentinel-mesh/logger";
import type { EventPublisher, EventSubscriber } from "@sentinel-mesh/queue";
import { BudgetLedger } from "./budget.js";
import { wrapIdempotent, type ProcessedEventStore } from "./idempotency.js";
import { OutboxPublisher, type EventOutbox } from "./outbox.js";
import type { TaskRecord, TaskStore } from "./task-store.js";
import type { RunStore } from "./run-store.js";

/**
 * OrchestrationEngine: the multi-agent orchestration core.
 *
 * Responsibilities:
 *  - register typed agent definitions (manifest-validated by the SDK)
 *  - issue tasks (durable task store, outbox-recorded events, trace ids)
 *  - execute tasks through the SDK harness with per-agent budgets
 *  - retries (fixed deterministic backoff, attempt tracking, dedupe)
 *  - deadlines (pre-check in harness, expiry scan in tick)
 *  - cancellation (cooperative signals + run/task cancellation)
 *  - idempotent event consumption (per-consumer processed-event stores)
 *  - durable workflow runs (contracts reducer + run store + state events)
 *
 * Execution model in phase 1: the in-memory event bus dispatches
 * synchronously, so issueTask drives execution to completion inline. Retries,
 * budget parking, and deadline expiry are driven by tick(), which the host
 * service runs on a timer (and tests run directly with an injected clock).
 */

export class OrchestrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestrationError";
  }
}

export interface Clock {
  now(): Date;
}

export interface IssueTaskRequest {
  agentId: string;
  taskType: TaskType;
  input: unknown;
  traceId?: string;
  /** Links the task's events to a caller correlation (e.g. a run id). */
  correlationId?: string;
  deadlineAt?: string;
  budgetMs?: number;
  idempotencyKey?: string;
  workflowRunId?: string;
  workflowStepId?: string;
}

export interface WorkflowStepSpec {
  name: string;
  agentId: string;
  taskType: TaskType;
  /** Builds the step input from prior step outputs (index-aligned). */
  buildInput: (context: { priorOutputs: unknown[]; run: WorkflowRun }) => unknown;
  budgetMs?: number;
}

export interface WorkflowPlan {
  workflowName: string;
  input?: unknown;
  steps: WorkflowStepSpec[];
  deadlineAt?: string;
}

export interface EngineDeps {
  bus: EventPublisher & EventSubscriber;
  taskStore: TaskStore;
  runStore: RunStore;
  outbox: EventOutbox;
  processedEvents: ProcessedEventStore;
  clock: Clock;
  logger: Logger;
  /** Injectable uuid source for deterministic tests/traces. */
  uuid?: () => string;
}

export interface StartedWorkflow {
  run: WorkflowRun;
  traceId: string;
}

export class OrchestrationEngine {
  private readonly agents = new Map<string, AnyAgentDefinition>();
  private readonly plans = new Map<string, WorkflowPlan>();
  private readonly traceByRun = new Map<string, string>();
  private readonly traces = new Map<string, EventEnvelope[]>();
  private readonly cancellations = new Map<string, CancelState>();
  private readonly ledger = new BudgetLedger();
  private readonly publisher: EventPublisher;
  private readonly uuid: () => string;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(private readonly deps: EngineDeps) {
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.uuid = deps.uuid ?? (() => randomUUID());
    this.publisher = new OutboxPublisher(deps.bus, deps.outbox);

    void deps.bus.subscribe(
      wrapIdempotent(
        "orchestrator.task-issued",
        deps.processedEvents,
        (envelope) => this.onTaskIssued(envelope),
        (envelope) => this.logger.debug({ eventId: envelope.eventId }, "duplicate_task_issued_skipped"),
      ),
    );

    void deps.bus.subscribe(
      wrapIdempotent(
        "orchestrator.task-completed",
        deps.processedEvents,
        (envelope) => this.onTaskCompleted(envelope),
        (envelope) => this.logger.debug({ eventId: envelope.eventId }, "duplicate_task_completed_skipped"),
      ),
    );
  }

  register(definition: AnyAgentDefinition): void {
    const agentId = definition.manifest.agentId;
    if (this.agents.has(agentId)) {
      throw new OrchestrationError(`agent '${agentId}' is already registered`);
    }
    this.agents.set(agentId, definition);
  }

  hasAgent(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  // ---------------------------------------------------------------------
  // Tracing
  // ---------------------------------------------------------------------

  private async dispatch(envelope: EventEnvelope, traceId?: string): Promise<void> {
    if (traceId) {
      const list = this.traces.get(traceId) ?? [];
      list.push(envelope);
      this.traces.set(traceId, list);
    }
    await this.publisher.publish(envelope);
  }

  getTrace(traceId: string): EventEnvelope[] {
    return [...(this.traces.get(traceId) ?? [])];
  }

  // ---------------------------------------------------------------------
  // Task lifecycle
  // ---------------------------------------------------------------------

  async issueTask(request: IssueTaskRequest): Promise<AgentTask> {
    const definition = this.agents.get(request.agentId);
    if (!definition) {
      throw new OrchestrationError(`unknown agent '${request.agentId}'`);
    }
    if (!definition.manifest.supportedTaskTypes.includes(request.taskType)) {
      throw new OrchestrationError(
        `agent '${request.agentId}' does not support task type '${request.taskType}'`,
      );
    }

    if (request.idempotencyKey) {
      const existing = await this.deps.taskStore.findByIdempotencyKey(request.idempotencyKey);
      if (existing) {
        this.logger.info(
          { taskId: existing.task.taskId, idempotencyKey: request.idempotencyKey },
          "idempotent_task_replay",
        );
        return existing.task;
      }
    }

    const traceId = request.traceId ?? this.uuid();
    const task = AgentTask.parse({
      schemaVersion: 1,
      taskId: this.uuid(),
      assignedAgentId: request.agentId,
      taskType: request.taskType,
      input: request.input ?? null,
      issuedAt: this.clock.now().toISOString(),
      deadlineAt: request.deadlineAt,
      priority: "normal",
      traceId,
      idempotencyKey: request.idempotencyKey,
      attempt: 1,
      workflowRunId: request.workflowRunId,
      workflowStepId: request.workflowStepId,
      budgetMs: request.budgetMs,
    });

    await this.deps.taskStore.save({
      task,
      status: "pending",
      attemptExecuted: 0,
      updatedAt: this.clock.now().toISOString(),
    });

    await this.dispatch(
      createEnvelope(EventCatalog["agent.task.issued"], task, {
        actor: { kind: "system", id: "orchestrator" },
        eventId: this.uuid(),
        occurredAt: this.clock.now().toISOString(),
        correlationId: request.correlationId ?? traceId,
      }),
      traceId,
    );
    return task;
  }

  private async onTaskIssued(envelope: EventEnvelope): Promise<void> {
    if (envelope.type !== "agent.task.issued") {
      return;
    }
    const { payload: task } = parseTypedEnvelope(EventCatalog["agent.task.issued"], envelope);
    const record = await this.deps.taskStore.find(task.taskId);
    if (!record) {
      this.logger.warn({ taskId: task.taskId }, "issued_event_without_task_record");
      return;
    }
    if (task.attempt <= record.attemptExecuted) {
      this.logger.info({ taskId: task.taskId, attempt: task.attempt }, "duplicate_attempt_skipped");
      return;
    }

    const definition = this.agents.get(task.assignedAgentId);
    if (!definition) {
      await this.finalize(record, {
        status: "failed",
        error: { code: "UNKNOWN_AGENT", message: `agent '${task.assignedAgentId}' is not registered` },
        startedAt: record.updatedAt,
        completedAt: this.clock.now().toISOString(),
      });
      return;
    }

    // Per-agent resource budgets.
    const acquire = this.ledger.tryAcquire(
      task.assignedAgentId,
      {
        maxTasksPerMinute: definition.budget.maxTasksPerMinute,
        maxConcurrent: definition.budget.maxConcurrent,
      },
      this.clock.now().getTime(),
    );
    if (!acquire.ok) {
      await this.deps.taskStore.save({
        ...record,
        status: "retry-scheduled",
        retryAt: new Date(this.clock.now().getTime() + acquire.retryInMs).toISOString(),
        updatedAt: this.clock.now().toISOString(),
      });
      this.logger.info(
        { taskId: task.taskId, agentId: task.assignedAgentId, retryInMs: acquire.retryInMs },
        "task_parked_by_budget",
      );
      return;
    }

    await this.deps.taskStore.save({
      ...record,
      status: "running",
      attemptExecuted: task.attempt,
      updatedAt: this.clock.now().toISOString(),
    });

    const cancel = new CancelState();
    this.cancellations.set(task.taskId, cancel);
    this.ledger.begin(task.assignedAgentId);
    let outcome;
    try {
      outcome = await executeTask(definition, task, {
        now: () => this.clock.now(),
        logger: this.logger.child({ taskId: task.taskId, agentId: task.assignedAgentId }),
        signal: cancel,
      });
    } finally {
      this.ledger.end(task.assignedAgentId);
      this.cancellations.delete(task.taskId);
    }

    const executedRecord = await this.deps.taskStore.find(task.taskId);
    const base = executedRecord ?? record;

    if (outcome.status === "success") {
      await this.finalize(base, outcome);
      return;
    }

    if (outcome.retryable && task.attempt < definition.retry.maxAttempts) {
      const nextTask = AgentTask.parse({ ...task, attempt: task.attempt + 1 });
      await this.deps.taskStore.save({
        task: nextTask,
        status: "retry-scheduled",
        attemptExecuted: task.attempt,
        retryAt: new Date(this.clock.now().getTime() + definition.retry.backoffMs).toISOString(),
        updatedAt: this.clock.now().toISOString(),
      });
      this.logger.warn(
        { taskId: task.taskId, attempt: task.attempt, code: outcome.error?.code },
        "task_retry_scheduled",
      );
      return;
    }

    await this.finalize(base, outcome);
  }

  /** Persist a terminal outcome and publish agent.task.completed. */
  private async finalize(
    record: TaskRecord,
    outcome: {
      status: "success" | "failed";
      output?: unknown;
      error?: { code: string; message: string };
      startedAt: string;
      completedAt: string;
    },
  ): Promise<void> {
    const result: AgentTaskResult = {
      schemaVersion: 1,
      taskId: record.task.taskId,
      agentId: record.task.assignedAgentId,
      status: outcome.status === "success" ? "success" : "failed",
      output: outcome.output,
      error: outcome.error,
      startedAt: outcome.startedAt,
      completedAt: outcome.completedAt,
      traceId: record.task.traceId,
      attempt: record.task.attempt,
    };
    await this.deps.taskStore.save({
      task: record.task,
      status: outcome.status === "success" ? "succeeded" : "failed",
      attemptExecuted: record.task.attempt,
      result,
      updatedAt: this.clock.now().toISOString(),
    });
    await this.dispatch(
      createEnvelope(EventCatalog["agent.task.completed"], result, {
        actor: { kind: "system", id: "orchestrator" },
        eventId: this.uuid(),
        occurredAt: this.clock.now().toISOString(),
        correlationId: record.task.traceId,
      }),
      record.task.traceId,
    );
  }

  private async onTaskCompleted(envelope: EventEnvelope): Promise<void> {
    if (envelope.type !== "agent.task.completed") {
      return;
    }
    const { payload: result } = parseTypedEnvelope(EventCatalog["agent.task.completed"], envelope);
    const record = await this.deps.taskStore.find(result.taskId);
    if (!record) {
      return;
    }
    const { workflowRunId, workflowStepId, traceId } = record.task;
    if (!workflowRunId || !workflowStepId) {
      return;
    }
    const run = await this.deps.runStore.find(workflowRunId);
    if (!run) {
      return;
    }
    if (run.status !== "running") {
      // Run already terminal (e.g. cancelled): nothing to advance.
      this.logger.info({ runId: workflowRunId, status: run.status }, "late_result_ignored");
      return;
    }

    if (result.status === "success") {
      const next = applyWorkflowCommand(run, {
        type: "step.succeeded",
        stepId: workflowStepId,
        output: result.output ?? null,
      });
      await this.deps.runStore.save(next);
      if (next.status === "completed") {
        await this.publishRunTransition(run, next, traceId, "all steps succeeded");
      } else {
        await this.runNextStep(next);
      }
    } else {
      const next = applyWorkflowCommand(run, {
        type: "step.failed",
        stepId: workflowStepId,
        error: result.error ?? { code: "TASK_FAILED", message: "task failed without an error" },
      });
      await this.deps.runStore.save(next);
      await this.publishRunTransition(run, next, traceId, `step '${workflowStepId}' failed`);
    }
  }

  // ---------------------------------------------------------------------
  // Workflows
  // ---------------------------------------------------------------------

  async startWorkflow(plan: WorkflowPlan): Promise<StartedWorkflow> {
    if (plan.steps.length === 0) {
      throw new OrchestrationError("workflow plan needs at least one step");
    }
    for (const step of plan.steps) {
      const definition = this.agents.get(step.agentId);
      if (!definition) {
        throw new OrchestrationError(`unknown agent '${step.agentId}'`);
      }
      if (!definition.manifest.supportedTaskTypes.includes(step.taskType)) {
        throw new OrchestrationError(
          `agent '${step.agentId}' does not support task type '${step.taskType}'`,
        );
      }
    }

    const run = createWorkflowRun({
      workflowName: plan.workflowName,
      stepNames: plan.steps.map((step) => step.name),
    });
    const traceId = this.uuid();
    this.plans.set(run.runId, plan);
    this.traceByRun.set(run.runId, traceId);
    await this.deps.runStore.save(run);

    const started = applyWorkflowCommand(run, { type: "run.started" });
    await this.deps.runStore.save(started);
    await this.publishRunTransition(run, started, traceId, "workflow started");

    await this.runNextStep(started);

    const final = await this.deps.runStore.find(run.runId);
    return { run: final ?? started, traceId };
  }

  private async runNextStep(run: WorkflowRun): Promise<void> {
    const plan = this.plans.get(run.runId);
    if (!plan) {
      throw new OrchestrationError(`no plan registered for run '${run.runId}'`);
    }
    const index = run.steps.findIndex((step) => step.status === "pending");
    if (index === -1) {
      return;
    }
    const runStep = run.steps[index];
    if (!runStep) {
      return;
    }
    const spec = plan.steps[index];
    if (!spec) {
      throw new OrchestrationError(`plan missing step at index ${index}`);
    }
    const priorOutputs = run.steps.slice(0, index).map((step) => step.output ?? null);
    const input = spec.buildInput({ priorOutputs, run });
    const withStarted = applyWorkflowCommand(run, { type: "step.started", stepId: runStep.stepId });
    await this.deps.runStore.save(withStarted);

    await this.issueTask({
      agentId: spec.agentId,
      taskType: spec.taskType,
      input,
      // Engine-wide convention: every event of a run shares correlationId = traceId.
      traceId: this.traceByRun.get(run.runId),
      deadlineAt: plan.deadlineAt,
      budgetMs: spec.budgetMs,
      workflowRunId: run.runId,
      workflowStepId: runStep.stepId,
    });
  }

  private async publishRunTransition(
    from: WorkflowRun,
    to: WorkflowRun,
    traceId: string | undefined,
    reason: string,
  ): Promise<void> {
    await this.dispatch(
      createEnvelope(
        EventCatalog["workflow.state.changed"],
        {
          runId: to.runId,
          workflowName: to.workflowName,
          from: from.status,
          to: to.status,
          reason,
        },
        {
          actor: { kind: "system", id: "orchestrator" },
          eventId: this.uuid(),
          occurredAt: this.clock.now().toISOString(),
          correlationId: traceId,
        },
      ),
      traceId,
    );
  }

  async getRun(runId: string): Promise<WorkflowRun | undefined> {
    return this.deps.runStore.find(runId);
  }

  async cancelRun(runId: string, reason = "cancelled by request"): Promise<WorkflowRun | undefined> {
    const run = await this.deps.runStore.find(runId);
    if (!run) {
      return undefined;
    }
    if (run.status !== "running" && run.status !== "pending" && run.status !== "waiting") {
      throw new WorkflowTransitionError(
        `run '${runId}' is already '${run.status}' and cannot be cancelled`,
      );
    }
    const next = applyWorkflowCommand(run, { type: "run.cancelled" });
    await this.deps.runStore.save(next);
    await this.publishRunTransition(run, next, this.traceByRun.get(runId), reason);

    for (const record of await this.deps.taskStore.findByWorkflowRun(runId)) {
      if (["pending", "retry-scheduled", "running"].includes(record.status)) {
        this.cancellations.get(record.task.taskId)?.cancel(reason);
        if (record.status !== "running") {
          await this.deps.taskStore.save({
            ...record,
            status: "cancelled",
            updatedAt: this.clock.now().toISOString(),
          });
        }
      }
    }
    return next;
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    return this.deps.taskStore.find(taskId);
  }

  /** Most recent workflow runs, newest first. */
  async recentRuns(limit = 20): Promise<WorkflowRun[]> {
    return this.deps.runStore.recent(limit);
  }

  async listTasks(statuses?: TaskRecord["status"][]): Promise<TaskRecord[]> {
    return this.deps.taskStore.listByStatuses(statuses ?? [
      "pending", "running", "retry-scheduled", "succeeded", "failed", "cancelled",
    ]);
  }

  async cancelTask(taskId: string, reason = "cancelled by request"): Promise<TaskRecord | undefined> {
    const record = await this.deps.taskStore.find(taskId);
    if (!record) {
      return undefined;
    }
    if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") {
      throw new WorkflowTransitionError(`task '${taskId}' is already '${record.status}'`);
    }
    this.cancellations.get(taskId)?.cancel(reason);
    const next: TaskRecord = {
      ...record,
      status: "cancelled",
      updatedAt: this.clock.now().toISOString(),
    };
    await this.deps.taskStore.save(next);
    return next;
  }

  // ---------------------------------------------------------------------
  // Tick: retries, budgets, deadlines
  // ---------------------------------------------------------------------

  /** Drives parked/failed work forward. Runs on a timer in the host service. */
  async tick(): Promise<void> {
    const nowMs = this.clock.now().getTime();

    for (const record of await this.deps.taskStore.listByStatuses(["pending", "retry-scheduled"])) {
      const deadlineMs = record.task.deadlineAt ? Date.parse(record.task.deadlineAt) : undefined;
      if (deadlineMs !== undefined && deadlineMs < nowMs) {
        await this.finalize(record, {
          status: "failed",
          error: { code: "DEADLINE_EXCEEDED", message: "task deadline passed before execution" },
          startedAt: record.updatedAt,
          completedAt: this.clock.now().toISOString(),
        });
      }
    }

    for (const record of await this.deps.taskStore.listByStatuses(["retry-scheduled"])) {
      if (record.retryAt && Date.parse(record.retryAt) > nowMs) {
        continue;
      }
      if (!this.agents.has(record.task.assignedAgentId)) {
        await this.finalize(record, {
          status: "failed",
          error: { code: "UNKNOWN_AGENT", message: `agent '${record.task.assignedAgentId}' is not registered` },
          startedAt: record.updatedAt,
          completedAt: this.clock.now().toISOString(),
        });
        continue;
      }
      await this.dispatch(
        createEnvelope(EventCatalog["agent.task.issued"], record.task, {
          actor: { kind: "system", id: "orchestrator" },
          eventId: this.uuid(),
          occurredAt: this.clock.now().toISOString(),
          correlationId: record.task.traceId,
        }),
        record.task.traceId,
      );
    }
  }

  private async fingerprint(): Promise<string> {
    const records = await this.deps.taskStore.listByStatuses([
      "pending", "running", "retry-scheduled", "succeeded", "failed", "cancelled",
    ]);
    return [...records]
      .sort((a, b) => a.task.taskId.localeCompare(b.task.taskId))
      .map((r) => `${r.task.taskId}:${r.status}:${r.attemptExecuted}`)
      .join(",");
  }

  /**
   * Repeatedly ticks until the system reaches a fixed point. Use with
   * retry policies of backoffMs 0 (or an advanced fake clock) in tests and
   * the synchronous dev flow.
   */
  async settle(maxRounds = 100): Promise<void> {
    for (let round = 0; round < maxRounds; round += 1) {
      const before = await this.fingerprint();
      await this.tick();
      const after = await this.fingerprint();
      if (before === after) {
        return;
      }
    }
    throw new OrchestrationError(`settle() did not reach a fixed point within ${maxRounds} rounds`);
  }
}
