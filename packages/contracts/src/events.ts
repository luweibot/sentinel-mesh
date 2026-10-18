import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IsoDateTime, Semver, Uuid } from "./primitives.js";
import { ChainId } from "./primitives.js";
import { AgentTask, AgentTaskResult } from "./task-contracts.js";
import { WorkflowRunStatus } from "./workflow-state.js";

/**
 * Versioned event envelopes.
 *
 * Every message that crosses a service boundary is wrapped in an envelope with
 * an explicit schema version. Producers build envelopes through `createEnvelope`
 * (which validates the payload against the registered event definition);
 * consumers validate with `parseEnvelope` / `parseTypedEnvelope`.
 *
 * Versioning policy (see docs/ARCHITECTURE.md):
 *  - Envelope structure changes bump EVENT_ENVELOPE_VERSION (breaking).
 *  - Additive payload changes bump the event definition's payload schema
 *    (non-breaking) and are documented per event.
 */

export const EVENT_ENVELOPE_VERSION = 1;

export const EventActor = z
  .object({
    kind: z.enum(["agent", "system", "human"]),
    id: z.string().min(1),
  })
  .strict();
export type EventActor = z.infer<typeof EventActor>;

const EnvelopeBase = z
  .object({
    schemaVersion: z.literal(EVENT_ENVELOPE_VERSION),
    eventId: Uuid,
    /** Event type name, e.g. "signal.created". Must exist in the EventCatalog to be publishable. */
    type: z.string().min(1),
    occurredAt: IsoDateTime,
    actor: EventActor,
    /** Links events that belong to the same logical flow, e.g. one signal's lifecycle. */
    correlationId: Uuid.optional(),
    /** Validated against the event definition's payload schema when published or consumed typed. */
    payload: z.unknown(),
  })
  .strict();

export type EventEnvelope<TPayload = unknown> = {
  schemaVersion: typeof EVENT_ENVELOPE_VERSION;
  eventId: string;
  type: string;
  occurredAt: string;
  actor: EventActor;
  correlationId?: string;
  payload: TPayload;
};

/** A named event type with its payload schema. Created via `defineEvent`. */
export interface EventDefinition<TName extends string = string, TPayloadSchema extends z.ZodType = z.ZodType> {
  readonly type: TName;
  readonly payloadSchema: TPayloadSchema;
}

export function defineEvent<TName extends string, TPayloadSchema extends z.ZodType>(
  type: TName,
  payloadSchema: TPayloadSchema,
): EventDefinition<TName, TPayloadSchema> {
  return { type, payloadSchema } as const;
}

export interface CreateEnvelopeContext {
  actor: EventActor;
  /** Defaults to a fresh UUID. */
  eventId?: string;
  occurredAt?: string;
  correlationId?: string;
}

/**
 * Build a validated envelope for a registered event definition.
 * Throws a ZodError when the payload does not satisfy the definition.
 */
export function createEnvelope<TName extends string, TPayloadSchema extends z.ZodType>(
  definition: EventDefinition<TName, TPayloadSchema>,
  payload: unknown,
  context: CreateEnvelopeContext,
): EventEnvelope<z.infer<TPayloadSchema>> {
  const parsedPayload = definition.payloadSchema.parse(payload);
  const envelope = EnvelopeBase.parse({
    schemaVersion: EVENT_ENVELOPE_VERSION,
    eventId: context.eventId ?? randomUUID(),
    type: definition.type,
    occurredAt: context.occurredAt ?? new Date().toISOString(),
    actor: context.actor,
    correlationId: context.correlationId ?? undefined,
    payload: parsedPayload,
  });
  // The base schema types payload as unknown; we know it parsed above.
  return envelope as unknown as EventEnvelope<z.infer<TPayloadSchema>>;
}

/** Validate envelope structure only (payload stays unknown). */
export function parseEnvelope(raw: unknown): EventEnvelope<unknown> {
  return EnvelopeBase.parse(raw) as EventEnvelope<unknown>;
}

/** Validate envelope structure AND payload against the given definition. */
export function parseTypedEnvelope<TName extends string, TPayloadSchema extends z.ZodType>(
  definition: EventDefinition<TName, TPayloadSchema>,
  raw: unknown,
): EventEnvelope<z.infer<TPayloadSchema>> {
  const envelope = EnvelopeBase.parse(raw);
  const payload = definition.payloadSchema.parse(envelope.payload);
  return { ...(envelope as object), payload } as unknown as EventEnvelope<z.infer<TPayloadSchema>>;
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export const SignalKind = z.enum(["copy-trade", "trend-entry", "manual"]);

export const SignalCreatedPayload = z
  .object({
    signalId: Uuid,
    chain: ChainId,
    kind: SignalKind,
    tokenIn: z.string().min(1),
    tokenOut: z.string().min(1),
    notionalUsdCents: z.number().int().positive(),
    sourceWallet: z.string().min(1).optional(),
  })
  .strict();
export type SignalCreatedPayload = z.infer<typeof SignalCreatedPayload>;

export const POLICY_CONTRACT_VERSION = 1;

/**
 * Policy decision. Phase 0 guardrail: `executionMode` is the literal
 * "simulation". There is no "live" execution mode in the schema, so no
 * component can represent a live trade authorization.
 */
export const PolicyDecision = z
  .object({
    schemaVersion: z.literal(POLICY_CONTRACT_VERSION),
    decisionId: Uuid,
    signalId: Uuid,
    verdict: z.enum(["allow", "reject", "requires-review"]),
    /** Hard-coded literal "simulation" in phase 0. */
    executionMode: z.literal("simulation"),
    reasons: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          /** "reject" reasons block the signal; "advisory" reasons inform review. */
          severity: z.enum(["reject", "advisory"]),
        })
        .strict(),
    ),
    policyVersion: Semver,
    evaluatedAt: IsoDateTime,
  })
  .strict();
export type PolicyDecision = z.infer<typeof PolicyDecision>;

/** Input to the policy engine. Deliberately minimal in phase 0. */
export const PolicyEvaluationRequest = z
  .object({
    schemaVersion: z.literal(POLICY_CONTRACT_VERSION),
    signalId: Uuid,
    chain: ChainId,
    tokenIn: z.string().min(1),
    tokenOut: z.string().min(1),
    notionalUsdCents: z.number().int().positive(),
    requestedAt: IsoDateTime,
  })
  .strict();
export type PolicyEvaluationRequest = z.infer<typeof PolicyEvaluationRequest>;

export const WorkflowStateChangedPayload = z
  .object({
    runId: Uuid,
    workflowName: z.string().min(1),
    from: WorkflowRunStatus,
    to: WorkflowRunStatus,
    reason: z.string().optional(),
  })
  .strict();
export type WorkflowStateChangedPayload = z.infer<typeof WorkflowStateChangedPayload>;

// ---------------------------------------------------------------------------
// Event catalog: the registry of every event type the mesh may emit.
// Publishing an event type not present here is a programming error.
// ---------------------------------------------------------------------------

export const EventCatalog = {
  "agent.task.issued": defineEvent("agent.task.issued", AgentTask),
  "agent.task.completed": defineEvent("agent.task.completed", AgentTaskResult),
  "signal.created": defineEvent("signal.created", SignalCreatedPayload),
  "policy.decision.recorded": defineEvent("policy.decision.recorded", PolicyDecision),
  "workflow.state.changed": defineEvent("workflow.state.changed", WorkflowStateChangedPayload),
} as const;

export type EventCatalogType = keyof typeof EventCatalog;

export const EVENT_TYPES: readonly string[] = Object.keys(EventCatalog);

export function isKnownEventType(type: string): type is EventCatalogType {
  return type in EventCatalog;
}
