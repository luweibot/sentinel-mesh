import "dotenv/config";
import { loadConfig } from "@sentinel-mesh/config";
import { createLogger } from "@sentinel-mesh/logger";
import { createPool, resolveMigrationsDir, runMigrations } from "@sentinel-mesh/database";

/** Migration entrypoint for the orchestrator service. */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({ service: "orchestrator-migrate", level: config.logLevel });

  if (!config.databaseUrl) {
    logger.fatal("DATABASE_URL is not set; there is nothing to migrate. In development without Postgres, no action is needed.");
    process.exit(1);
  }

  const pool = createPool(config.databaseUrl);
  try {
    const applied = await runMigrations(pool, resolveMigrationsDir());
    if (applied.length === 0) {
      logger.info("migrations_up_to_date");
    } else {
      logger.info({ applied }, "migrations_applied");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: "fatal", service: "orchestrator-migrate", msg: "migration_failed", err: String(error) }));
  process.exit(1);
});
