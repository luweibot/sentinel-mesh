import { randomUUID } from "node:crypto";
import type { WorkflowRun, WorkflowRunStatus, WorkflowStep } from "./workflow-state.js";
import { WorkflowRun as WorkflowRunSchema } from "./workflow-state.js";
import { Slug } from "./primitives.js";

/**
 * Pure, validated state machine for durable workflow runs.
 *
 * `applyWorkflowCommand` takes a run state plus one command and returns the
 * next run state. It is fully deterministic apart from `updatedAt` (and it
 * never mutates the input). Invalid transitions throw WorkflowTransitionError;
 * valid transitions are re-validated against the WorkflowRun schema before
 * being returned, so no invalid state can leak into persistence.
 *
 * Command semantics:
 *  - run.started        pending -> running
 *  - step.started       step pending -> running (run must be running)
 *  - step.succeeded     step running -> succeeded; run completes when all steps succeeded
 *  - step.failed        step running -> failed; run fails
 *  - run.cancelled      pending/running -> cancelled (remaining pending steps cancelled)
 */

export type WorkflowCommand =
  | { type: "run.started" }
  | { type: "step.started"; stepId: string }
  | { type: "step.succeeded"; stepId: string; output?: unknown }
  | { type: "step.failed"; stepId: string; error: { code: string; message: string } }
  | { type: "run.cancelled" };

export class WorkflowTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowTransitionError";
  }
}

export interface CreateWorkflowRunInput {
  runId?: string;
  workflowName: string;
  stepNames: string[];
  input?: unknown;
}

export function createWorkflowRun(input: CreateWorkflowRunInput): WorkflowRun {
  const now = new Date().toISOString();
  const workflowName = Slug.parse(input.workflowName);
  const steps: WorkflowStep[] = input.stepNames.map((name, index) => ({
    stepId: `${workflowName}-step-${index + 1}`,
    name,
    status: "pending" satisfies WorkflowStep["status"],
  }));
  return WorkflowRunSchema.parse({
    schemaVersion: 1,
    runId: input.runId ?? randomUUID(),
    workflowName,
    status: "pending",
    input: input.input ?? null,
    createdAt: now,
    updatedAt: now,
    steps,
  });
}

function findStep(run: WorkflowRun, stepId: string): WorkflowStep {
  const step = run.steps.find((s) => s.stepId === stepId);
  if (!step) {
    throw new WorkflowTransitionError(`unknown step '${stepId}' on run '${run.runId}'`);
  }
  return step;
}

function assertStatus(run: WorkflowRun, expected: WorkflowRunStatus[]): void {
  if (!expected.includes(run.status)) {
    throw new WorkflowTransitionError(
      `run '${run.runId}' is '${run.status}'; command only valid from ${expected.join("/")}`,
    );
  }
}

export function applyWorkflowCommand(run: WorkflowRun, command: WorkflowCommand): WorkflowRun {
  const now = new Date().toISOString();

  const next: WorkflowRun = structuredClone(run);

  switch (command.type) {
    case "run.started": {
      assertStatus(next, ["pending"]);
      next.status = "running";
      break;
    }
    case "step.started": {
      assertStatus(next, ["running"]);
      const step = findStep(next, command.stepId);
      if (step.status !== "pending") {
        throw new WorkflowTransitionError(
          `step '${command.stepId}' is '${step.status}'; only pending steps can start`,
        );
      }
      step.status = "running";
      step.startedAt = now;
      break;
    }
    case "step.succeeded": {
      assertStatus(next, ["running"]);
      const step = findStep(next, command.stepId);
      if (step.status !== "running") {
        throw new WorkflowTransitionError(
          `step '${command.stepId}' is '${step.status}'; only running steps can succeed`,
        );
      }
      step.status = "succeeded";
      step.finishedAt = now;
      if (command.output !== undefined) {
        step.output = command.output;
      }
      if (next.steps.every((s) => s.status === "succeeded" || s.status === "skipped")) {
        next.status = "completed";
        next.finishedAt = now;
      }
      break;
    }
    case "step.failed": {
      assertStatus(next, ["running"]);
      const step = findStep(next, command.stepId);
      if (step.status !== "running") {
        throw new WorkflowTransitionError(`step '${command.stepId}' is '${step.status}'; only running steps can fail`);
      }
      step.status = "failed";
      step.finishedAt = now;
      step.error = command.error;
      next.status = "failed";
      next.finishedAt = now;
      break;
    }
    case "run.cancelled": {
      assertStatus(next, ["pending", "running"]);
      next.status = "cancelled";
      next.finishedAt = now;
      for (const step of next.steps) {
        if (step.status === "pending") {
          step.status = "cancelled";
          step.finishedAt = now;
        }
      }
      break;
    }
  }

  next.updatedAt = now;
  // Re-validate: the reducer can never produce an invalid document.
  return WorkflowRunSchema.parse(next);
}
