import "dotenv/config";
import { loadConfig } from "@sentinel-mesh/config";
import { createLogger } from "@sentinel-mesh/logger";
import { InMemoryEventBus, createEventPublisher } from "@sentinel-mesh/queue";
import { DeterministicPolicyEngine } from "@sentinel-mesh/policy-engine";
import {
  OrchestrationEngine,
  InMemoryTaskStore,
  InMemoryRunStore,
  InMemoryEventOutbox,
  InMemoryProcessedEvents,
  PgTaskStore,
  PgRunStore,
  PgEventOutbox,
  PgProcessedEvents,
} from "@sentinel-mesh/orchestrator";
import { registerAllAgents } from "@sentinel-mesh/agents";
import { PgGuardStateJournal, PgSpendCapJournal } from "@sentinel-mesh/orchestrator";
import { buildExecutionStack, buildLiveTradeLegs, restoreGuardState } from "./execution.js";
import { buildSkillsStack, buildPaymentsStack } from "./skills-payments.js";
import { createPool } from "@sentinel-mesh/database";
import { buildApp } from "./app.js";
import { buildTreasuryStack } from "./treasury.js";

/**
 * Orchestrator service entrypoint.
 *
 * Dev (no DATABASE_URL): fully in-memory, deterministic, zero infra.
 * With DATABASE_URL: Postgres-backed task/run/outbox/processed-event stores;
 * the same engine and API surface either way.
 */

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({ service: "orchestrator", level: config.logLevel });

  const clock = { now: () => new Date() };
  const bus = new InMemoryEventBus();

  let pool: ReturnType<typeof createPool> | undefined;
  let storageMode = "in-memory";
  if (config.databaseUrl) {
    const databaseUrl = config.databaseUrl;
    pool = createPool(databaseUrl);
    storageMode = "postgres";
  }

  const engine = new OrchestrationEngine({
    bus,
    taskStore: pool ? new PgTaskStore(pool) : new InMemoryTaskStore(),
    runStore: pool ? new PgRunStore(pool) : new InMemoryRunStore(),
    outbox: pool ? new PgEventOutbox(pool) : new InMemoryEventOutbox(),
    processedEvents: pool ? new PgProcessedEvents(pool) : new InMemoryProcessedEvents(),
    clock,
    logger,
  });
  // SECURITY (audit 2026-10-19): durable guard journal when Postgres is
  // wired; guard state restores at boot BEFORE the server listens, so a
  // sleeping/restarted instance keeps idempotency, caps, kill switch and
  // the receipt ledger.
  const guardJournal = pool ? new PgGuardStateJournal(pool) : undefined;
  const spendCapJournal = pool ? new PgSpendCapJournal(pool, (error) => logger.error({ err: String(error) }, "spend_cap_journal_write_failed")) : undefined;

  // Shared API routes (merged deployment): the retired API service's
  // signal pipeline needs the same publisher/policy wiring it had.
  const publisher = await createEventPublisher({ redisUrl: config.redisUrl });
  const busMode = config.redisUrl ? "bullmq" : "in-memory";
  const policyEngine = new DeterministicPolicyEngine({
    policyVersion: "0.1.0",
    rules: {
      allowedChains: ["base", "solana"],
      maxNotionalUsdCents: config.policyMaxNotionalUsdCents,
    },
  });

  const execution = buildExecutionStack(config, logger, clock, {
    journal: guardJournal,
    // Live legs are built from runtime secrets only in live mode
    // (ADR-016). The config gate still rejects EXECUTION_MODE=live until
    // the owner releases it per docs/EXECUTION.md; this wiring activates
    // the moment it does.
    ...(config.executionMode === "live" ? { live: buildLiveTradeLegs(config, logger) } : {}),
  });
  registerAllAgents(engine, execution.port);
  const skills = buildSkillsStack(config, logger, clock).registry;
  const payments = buildPaymentsStack(config, logger, clock, { journal: spendCapJournal });

  if (guardJournal) {
    const snapshot = await guardJournal.restore();
    await restoreGuardState(snapshot, execution, logger);
    // x402 spend-cap utilization restores before traffic flows.
    payments.caps.restore(await spendCapJournal!.restore());
  }

  const app = buildApp({
    config,
    logger,
    engine,
    execution,
    skills,
    payments,
    api: { publisher, policyEngine, busMode },
    treasury: buildTreasuryStack(config, logger),
    storageMode,
    dbProbe: pool
      ? async () => {
          await pool!.query("select 1");
        }
      : undefined,
  });

  // Periodic tick: drives retries, budget parking, and deadline expiry.
  const tickIntervalMs = 1_000;
  const ticker = setInterval(() => {
    void engine.tick().catch((error: unknown) => {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, "tick_failed");
    });
  }, tickIntervalMs);
  // Do not hold the process open just for the ticker.
  ticker.unref?.();

  await app.listen({ port: config.orchestratorPort, host: "0.0.0.0" });
  logger.info(
    { port: config.orchestratorPort, storageMode, tickIntervalMs },
    "orchestrator_started",
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "orchestrator_stopping");
    clearInterval(ticker);
    try {
      await app.close();
      await pool?.end();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: "fatal", service: "orchestrator", msg: "startup_failed", err: String(error) }));
  process.exit(1);
});
