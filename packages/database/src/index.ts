export { createPool } from "./client.js";
export {
  MIGRATION_FILE_PATTERN,
  MigrationError,
  listMigrationFiles,
  runMigrations,
} from "./migrate.js";
export type { QueryExecutor, QueryResult } from "./migrate.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Absolute path to the bundled migrations directory.
 * Works both from source (src/index.ts -> ../migrations) and from the
 * compiled output (dist/index.js -> ../migrations).
 */
export function resolveMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "migrations");
}
