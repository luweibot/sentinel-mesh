import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig } from "@sentinel-mesh/config";
import { createLogger } from "@sentinel-mesh/logger";
import { createEventPublisher } from "@sentinel-mesh/queue";
import { DeterministicPolicyEngine } from "@sentinel-mesh/policy-engine";
import { createPool } from "@sentinel-mesh/database";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({ service: "api", level: config.logLevel });

  const publisher = await createEventPublisher({ redisUrl: config.redisUrl });
  const busMode = config.redisUrl ? "bullmq" : "in-memory";

  const policyEngine = new DeterministicPolicyEngine({
    policyVersion: "0.1.0",
    rules: {
      allowedChains: ["base", "solana"],
      maxNotionalUsdCents: config.policyMaxNotionalUsdCents,
    },
  });

  const databaseUrl = config.databaseUrl;
  let pool: ReturnType<typeof createPool> | undefined;
  const dbProbe = databaseUrl
    ? async (): Promise<void> => {
        pool ??= createPool(databaseUrl);
        await pool.query("select 1");
      }
    : undefined;

  const app = buildApp({
    config,
    logger,
    publisher,
    policyEngine,
    busMode,
    dbProbe,
  });

  await app.listen({ port: config.apiPort, host: "0.0.0.0" });
  logger.info(
    { port: config.apiPort, busMode, databaseConfigured: Boolean(config.databaseUrl) },
    "api_started",
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "api_stopping");
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
  // Logger may not exist yet if config itself failed.
  console.error(JSON.stringify({ level: "fatal", service: "api", msg: "startup_failed", err: String(error) }));
  process.exit(1);
});
