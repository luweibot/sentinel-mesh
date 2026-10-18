import { describe, expect, it } from "vitest";
import {
  WorkflowRun as WorkflowRunSchema,
  applyWorkflowCommand,
  createWorkflowRun,
  WorkflowTransitionError,
} from "../src/index.js";

describe("workflow reducer", () => {
  it("creates a pending run with named steps", () => {
    const run = createWorkflowRun({ workflowName: "signal-pipeline", stepNames: ["observe", "evaluate", "simulate"] });
    expect(run.status).toBe("pending");
    expect(run.steps.map((s) => s.name)).toEqual(["observe", "evaluate", "simulate"]);
    expect(WorkflowRunSchema.safeParse(run).success).toBe(true);
  });

  it("walks a happy path to completion", () => {
    let run = createWorkflowRun({ workflowName: "signal-pipeline", stepNames: ["a", "b"] });
    run = applyWorkflowCommand(run, { type: "run.started" });
    expect(run.status).toBe("running");
    run = applyWorkflowCommand(run, { type: "step.started", stepId: run.steps[0]!.stepId });
    run = applyWorkflowCommand(run, { type: "step.succeeded", stepId: run.steps[0]!.stepId, output: { ok: true } });
    expect(run.steps[0]!.output).toEqual({ ok: true });
    expect(run.status).toBe("running");
    run = applyWorkflowCommand(run, { type: "step.started", stepId: run.steps[1]!.stepId });
    run = applyWorkflowCommand(run, { type: "step.succeeded", stepId: run.steps[1]!.stepId });
    expect(run.status).toBe("completed");
    expect(run.finishedAt).toBeDefined();
  });

  it("fails the run when a step fails", () => {
    let run = createWorkflowRun({ workflowName: "signal-pipeline", stepNames: ["a"] });
    run = applyWorkflowCommand(run, { type: "run.started" });
    run = applyWorkflowCommand(run, { type: "step.started", stepId: run.steps[0]!.stepId });
    run = applyWorkflowCommand(run, {
      type: "step.failed",
      stepId: run.steps[0]!.stepId,
      error: { code: "E_TEST", message: "boom" },
    });
    expect(run.status).toBe("failed");
    expect(run.steps[0]!.error?.code).toBe("E_TEST");
  });

  it("cancels pending steps when the run is cancelled", () => {
    let run = createWorkflowRun({ workflowName: "signal-pipeline", stepNames: ["a", "b"] });
    run = applyWorkflowCommand(run, { type: "run.started" });
    run = applyWorkflowCommand(run, { type: "step.started", stepId: run.steps[0]!.stepId });
    run = applyWorkflowCommand(run, { type: "run.cancelled" });
    expect(run.status).toBe("cancelled");
    expect(run.steps[0]!.status).toBe("running");
    expect(run.steps[1]!.status).toBe("cancelled");
  });

  it("rejects invalid transitions", () => {
    const run = createWorkflowRun({ workflowName: "signal-pipeline", stepNames: ["a"] });
    // Cannot start a step before the run started.
    expect(() => applyWorkflowCommand(run, { type: "step.started", stepId: run.steps[0]!.stepId })).toThrow(
      WorkflowTransitionError,
    );
    // Cannot start a run twice.
    const started = applyWorkflowCommand(run, { type: "run.started" });
    expect(() => applyWorkflowCommand(started, { type: "run.started" })).toThrow(WorkflowTransitionError);
    // Cannot succeed a step that never started.
    expect(() => applyWorkflowCommand(started, { type: "step.succeeded", stepId: started.steps[0]!.stepId })).toThrow(
      WorkflowTransitionError,
    );
    // Unknown step id.
    expect(() => applyWorkflowCommand(started, { type: "step.started", stepId: "nope" })).toThrow(
      WorkflowTransitionError,
    );
  });

  it("does not mutate the input run", () => {
    const run = createWorkflowRun({ workflowName: "signal-pipeline", stepNames: ["a"] });
    const snapshot = JSON.stringify(run);
    applyWorkflowCommand(run, { type: "run.started" });
    expect(JSON.stringify(run)).toBe(snapshot);
  });
});
