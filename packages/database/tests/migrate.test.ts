import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MigrationError,
  listMigrationFiles,
  resolveMigrationsDir,
  runMigrations,
  type QueryExecutor,
  type QueryResult,
} from "../src/index.js";

class FakePgClient implements QueryExecutor {
  appliedNames: string[] = [];
  readonly executed: Array<{ sql: string; values?: readonly unknown[] }> = [];

  constructor(applied: string[] = []) {
    this.appliedNames = [...applied];
  }

  async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.executed.push({ sql: text, values });
    if (text.startsWith("select name from schema_migrations")) {
      return { rows: this.appliedNames.map((name) => ({ name })) };
    }
    if (text.startsWith("insert into schema_migrations")) {
      this.appliedNames.push(String(values?.[0]));
      return { rows: [] };
    }
    return { rows: [] };
  }
}

describe("migration runner", () => {
  it("lists the bundled migrations in order with valid names", async () => {
    const files = await listMigrationFiles(resolveMigrationsDir());
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toEqual([...files].sort());
    expect(files[0]).toBe("001_events_outbox.sql");
  });

  it("applies pending migrations in order inside transactions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mig-"));
    try {
      await writeFile(join(dir, "001_first.sql"), "create table a ();");
      await writeFile(join(dir, "002_second.sql"), "create table b ();");
      const client = new FakePgClient();
      const applied = await runMigrations(client, dir);
      expect(applied).toEqual(["001_first.sql", "002_second.sql"]);
      // BEGIN and COMMIT per migration.
      const sqls = client.executed.map((e) => e.sql);
      expect(sqls.filter((s) => s.trim() === "BEGIN")).toHaveLength(2);
      expect(sqls.filter((s) => s.trim() === "COMMIT")).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("skips already-applied migrations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mig-"));
    try {
      await writeFile(join(dir, "001_first.sql"), "create table a ();");
      const client = new FakePgClient(["001_first.sql"]);
      const applied = await runMigrations(client, dir);
      expect(applied).toEqual([]);
      expect(client.executed.some((e) => e.sql.includes("create table a"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rolls back and reports when a migration statement fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mig-"));
    class FailingClient extends FakePgClient {
      override async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
        if (text === "create table boom ();") {
          throw new Error("syntax error");
        }
        return super.query(text, values);
      }
    }
    try {
      await writeFile(join(dir, "001_boom.sql"), "create table boom ();");
      const client = new FailingClient();
      await expect(runMigrations(client, dir)).rejects.toThrow(MigrationError);
      const sqls = client.executed.map((e) => e.sql);
      expect(sqls.some((s) => s.trim() === "ROLLBACK")).toBe(true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects badly named migration files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mig-"));
    try {
      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "not_a_migration.sql"), "select 1;");
      await expect(listMigrationFiles(dir)).rejects.toThrow(MigrationError);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects empty migration files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mig-"));
    try {
      await writeFile(join(dir, "001_empty.sql"), "   ");
      await expect(runMigrations(new FakePgClient(), dir)).rejects.toThrow(MigrationError);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
