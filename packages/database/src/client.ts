import { Pool } from "pg";

/**
 * Postgres client factory. Callers pass a validated connection string from
 * @sentinel-mesh/config. Returns a pg Pool; lifecycle (end on shutdown)
 * belongs to the caller.
 */
export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    // Phase 0: fail fast instead of hanging on a bad connection string.
    connectionTimeoutMillis: 5_000,
  });
}
