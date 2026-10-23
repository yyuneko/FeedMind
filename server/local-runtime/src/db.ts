import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { D1Database, D1PreparedStatement, D1Result } from "../../../workers/shared/src/cloudflare";

function binding(value: unknown): string | number | bigint | Buffer | null {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`Unsupported SQLite binding: ${Object.prototype.toString.call(value)}`);
}

class LocalPreparedStatement implements D1PreparedStatement {
  readonly sql: string;
  private readonly database: Database.Database;
  private values: unknown[] = [];

  constructor(database: Database.Database, sql: string) {
    this.database = database;
    this.sql = sql;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    const prepared = new LocalPreparedStatement(this.database, this.sql);
    prepared.values = values;
    return prepared;
  }

  raw(): { statement: Database.Statement; values: Array<string | number | bigint | Buffer | null> } {
    const indexes: number[] = [];
    const sql = this.sql.replace(/\?(\d+)/g, (_match, raw: string) => {
      indexes.push(Number(raw) - 1);
      return "?";
    });
    const source = this.values.map(binding);
    return {
      statement: this.database.prepare(sql),
      values: indexes.length > 0 ? indexes.map((index) => source[index]!) : source,
    };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const { statement, values } = this.raw();
    return (statement.get(...values) as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const { statement, values } = this.raw();
    return { success: true, results: statement.all(...values) as T[] };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const { statement, values } = this.raw();
    if (statement.reader) return { success: true, results: statement.all(...values) as T[] };
    const info = statement.run(...values);
    return { success: true, meta: { changes: info.changes } };
  }
}

export class LocalDatabase implements D1Database {
  readonly native: Database.Database;

  constructor(path: string, readonly = false) {
    mkdirSync(dirname(path), { recursive: true });
    this.native = new Database(path, { readonly, fileMustExist: readonly });
    this.native.pragma("foreign_keys = ON");
    this.native.pragma("busy_timeout = 5000");
    if (!readonly) this.native.pragma("journal_mode = WAL");
  }

  prepare(query: string): D1PreparedStatement {
    return new LocalPreparedStatement(this.native, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return this.native.transaction(() => statements.map((candidate) => {
      if (!(candidate instanceof LocalPreparedStatement)) throw new TypeError("Statement belongs to another database adapter");
      const { statement, values } = candidate.raw();
      if (statement.reader) return { success: true, results: statement.all(...values) as T[] };
      const info = statement.run(...values);
      return { success: true, meta: { changes: info.changes } };
    }))();
  }

  close(): void {
    this.native.close();
  }
}

function stableMigrationSource(directory: string): string {
  const normalized = directory.replaceAll("\\", "/").replace(/\/$/, "");
  for (const source of ["workers/migrations", "server/local-runtime/migrations"]) {
    if (normalized === source || normalized.endsWith(`/${source}`)) return source;
  }
  return normalized;
}

function normalizeLegacyMigrationSources(database: LocalDatabase, source: string): void {
  const rows = database.native.prepare("SELECT source, name, applied_at FROM local_schema_migrations")
    .all() as Array<{ source: string; name: string; applied_at: string }>;
  const legacy = rows.filter((row) => {
    const normalized = row.source.replaceAll("\\", "/").replace(/\/$/, "");
    return row.source !== source && normalized.endsWith(`/${source}`);
  });
  if (!legacy.length) return;
  database.native.transaction(() => {
    const insert = database.native.prepare(`INSERT OR IGNORE INTO local_schema_migrations(source, name, applied_at)
      VALUES (?, ?, ?)`);
    const remove = database.native.prepare("DELETE FROM local_schema_migrations WHERE source = ? AND name = ?");
    for (const row of legacy) {
      insert.run(source, row.name, row.applied_at);
      remove.run(row.source, row.name);
    }
  })();
}

export function applyMigrations(database: LocalDatabase, directories: string[]): string[] {
  database.native.exec(`CREATE TABLE IF NOT EXISTS local_schema_migrations (
    source TEXT NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL,
    PRIMARY KEY (source, name)
  )`);
  const applied: string[] = [];
  for (const directory of directories) {
    const source = stableMigrationSource(directory);
    normalizeLegacyMigrationSources(database, source);
    for (const name of readdirSync(directory, { encoding: "utf8" }).filter((item) => item.endsWith(".sql")).sort()) {
      const exists = database.native.prepare("SELECT 1 FROM local_schema_migrations WHERE source = ? AND name = ?")
        .get(source, name);
      if (exists) continue;
      const sql = readFileSync(join(directory, name), "utf8");
      database.native.transaction(() => {
        database.native.exec(sql);
        database.native.prepare("INSERT INTO local_schema_migrations(source, name, applied_at) VALUES (?, ?, ?)")
          .run(source, name, new Date().toISOString());
      })();
      applied.push(name);
    }
  }
  return applied;
}
