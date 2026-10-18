import type { ResearchOutput } from "./research-agent.js";
import type { VerificationOutput } from "./source-verification-agent.js";
import type { WorkflowPlan } from "@sentinel-mesh/orchestrator";
import type { WorkflowRun } from "@sentinel-mesh/contracts";

/**
 * The research collaboration workflow:
 *
 *   1. research-topic        (research agent)          topic -> evidence + limitations
 *   2. verify-sources        (verification agent)      evidence -> verdicts + verified subset
 *   3. summarize-news        (news intelligence agent) verified evidence -> sentiment + topics
 *
 * Step inputs are derived from prior outputs (index-aligned). Unverified
 * evidence never reaches the news agent; suspicious evidence never reaches
 * the news agent because it is unverified by definition.
 */
export function researchWorkflowPlan(options: { topic: string; maxDocuments?: number }): WorkflowPlan {
  const topic = options.topic;
  const maxDocuments = options.maxDocuments ?? 3;
  return {
    workflowName: "research-collaboration",
    input: { topic, maxDocuments },
    steps: [
      {
        name: "research",
        agentId: "research-agent",
        taskType: "research-topic",
        buildInput: () => ({ topic, maxDocuments }),
      },
      {
        name: "verify-sources",
        agentId: "source-verification-agent",
        taskType: "verify-sources",
        buildInput: ({ priorOutputs }) => {
          const research = priorOutputs[0] as ResearchOutput;
          return { evidence: research.evidence };
        },
      },
      {
        name: "news-intelligence",
        agentId: "news-intelligence-agent",
        taskType: "summarize-news",
        buildInput: ({ priorOutputs }) => {
          const verification = priorOutputs[1] as VerificationOutput;
          return { topic, evidence: verification.verifiedEvidence };
        },
      },
    ],
  };
}

/** Human-readable explanation of a run, for docs and traces. */
export function describeRun(run: WorkflowRun): string {
  return `${run.workflowName} run ${run.runId} is ${run.status} with steps: ${run.steps
    .map((step) => `${step.name}=${step.status}`)
    .join(", ")}`;
}
