import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Minimal, dependency-free SQL migration runner.
 *
 *  - Migrations are plain, ordered .sql files in `migrations/`
 *    (NNN_name.sql).
 *  - The runner owns the `schema_migrations` bookkeeping table and applies
 *    each pending migration inside its own transaction.
 *  - Already-applied migrations (by filename) are skipped, so running the
 *    runner repeatedly is safe.
 *  - `QueryExecutor` is a narrow structural interface satisfied by a pg Pool
 *    or PoolClient, which lets tests drive the runner with a fake.
 */

export interface QueryResult {
  rows: ReadonlyArray<Record<string, unknown>>;
}

export interface QueryExecutor {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
}

export const MIGRATION_FILE_PATTERN = /^\d{3}_[a-z0-9_-]+\.sql$/;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  const sqlFiles = entries.filter((entry) => entry.endsWith(".sql")).sort();
  const invalid = sqlFiles.filter((file) => !MIGRATION_FILE_PATTERN.test(file));
  if (invalid.length > 0) {
    throw new MigrationError(
      `migration files must match NNN_name.sql: ${invalid.join(", ")}`,
    );
  }
  return sqlFiles;
}

export async function runMigrations(client: QueryExecutor, migrationsDir: string): Promise<string[]> {
  await client.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = await listMigrationFiles(migrationsDir);
  const appliedResult = await client.query("select name from schema_migrations");
  const applied = new Set(
    appliedResult.rows.map((row) => String(row["name"])),
  );

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), "utf8");
    if (sql.trim().length === 0) {
      throw new MigrationError(`migration '${file}' is empty`);
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("COMMIT");
      newlyApplied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new MigrationError(`migration '${file}' failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return newlyApplied;
}
