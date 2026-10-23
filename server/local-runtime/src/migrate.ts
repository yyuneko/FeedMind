import Database from "better-sqlite3";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeConfig } from "./config";
import { applyMigrations, LocalDatabase } from "./db";
import { safeObjectPath } from "./content";
import { contentHtmlToText } from "../../../workers/shared/src/content-blocks";

const here = dirname(fileURLToPath(import.meta.url));
const businessMigrations = resolve(here, "../../../workers/migrations");
const runtimeMigrations = resolve(here, "../migrations");

function argument(name: string, fallback = ""): string {
  const direct = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function table(database: Database.Database, name: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columns(database: Database.Database, name: string): Set<string> {
  if (!table(database, name)) return new Set();
  return new Set((database.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map((row) => row.name));
}

function deleteRows(database: Database.Database, tableName: string, predicate = "1 = 1"): number {
  if (!table(database, tableName)) return 0;
  const triggers = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql IS NOT NULL")
    .all(tableName) as Array<{ name: string; sql: string }>;
  for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
  const changes = database.prepare(`DELETE FROM "${tableName.replaceAll('"', '""')}" WHERE ${predicate}`).run().changes;
  for (const trigger of triggers) database.exec(trigger.sql);
  return changes;
}

function sanitize(database: Database.Database): Record<string, number> {
  const removed: Record<string, number> = {};
  const remove = (name: string, predicate?: string) => { removed[name] = deleteRows(database, name, predicate); };
  database.pragma("defer_foreign_keys = ON");
  database.transaction(() => {
    if (table(database, "translations")) {
      database.exec(`UPDATE translations SET status = 'pending', workflow_instance_id = NULL,
        translated_title = NULL, result_key = NULL, result_hash = NULL, result_bytes = NULL,
        content_html_key = NULL, started_at = NULL, completed_at = NULL, cancel_requested_at = NULL
        WHERE status IN ('running', 'cancel_requested')`);
      removed.translation_parent_references_cleared = database.prepare(`UPDATE translations SET parent_translation_id = NULL
        WHERE parent_translation_id IS NOT NULL AND parent_translation_id NOT IN
          (SELECT id FROM translations WHERE status IN ('completed', 'pending'))`).run().changes;
      remove("translations", "status NOT IN ('completed', 'pending')");
    }
    remove("translation_diagnostics");
    remove("translation_batches");
    if (table(database, "translation_attempts")) {
      remove("translation_attempts", `translation_id NOT IN (SELECT id FROM translations WHERE status = 'pending')
        OR attempt <> (SELECT MAX(latest.attempt) FROM translation_attempts latest
          WHERE latest.translation_id = translation_attempts.translation_id)`);
      database.exec(`UPDATE translation_attempts SET status = 'pending', workflow_instance_id = NULL,
        error_code = NULL, error_message = NULL, input_tokens = NULL, output_tokens = NULL,
        thinking_tokens = NULL, provider_latency_ms = NULL, started_at = NULL, completed_at = NULL`);
    }
    if (table(database, "article_classifications") && columns(database, "article_classifications").has("is_current")) {
      remove("article_classifications", "is_current <> 1");
    }
    remove("article_preprocessing_diagnostics");
    if (table(database, "article_preprocessing_runs")) {
      const current = columns(database, "article_preprocessing_runs").has("is_current") ? " OR is_current <> 1" : "";
      remove("article_preprocessing_runs", `status <> 'completed'${current}`);
    }
    if (table(database, "article_preprocessing_tasks")) {
      database.exec(`UPDATE article_preprocessing_tasks SET status = 'pending', workflow_instance_id = NULL,
        error_code = NULL, error_message = NULL, started_at = NULL, completed_at = NULL
        WHERE status = 'running'`);
      remove("article_preprocessing_tasks", `id NOT IN (SELECT task_id FROM article_preprocessing_runs)
        AND status <> 'pending'`);
    }
    if (table(database, "article_parse_tasks")) {
      database.exec(`UPDATE article_parse_tasks SET status = 'pending', error_code = NULL, error_message = NULL,
        started_at = NULL, completed_at = NULL, heartbeat_at = NULL WHERE status = 'running'`);
      remove("article_parse_tasks", "status <> 'pending'");
    }
    if (table(database, "article_content_block_backfill_tasks")) {
      database.exec(`UPDATE article_content_block_backfill_tasks SET status = 'pending', queued_at = NULL,
        started_at = NULL, completed_at = NULL, error_message = NULL, updated_at = created_at
        WHERE status IN ('queued', 'running')`);
      remove("article_content_block_backfill_tasks", "status <> 'pending'");
    }
    if (table(database, "articles")) {
      database.exec("UPDATE articles SET parse_status = 'pending', parse_error = NULL WHERE parse_status = 'running'");
    }
    if (table(database, "feeds")) {
      database.exec("UPDATE feeds SET fetch_status = 'pending' WHERE fetch_status = 'running'");
    }
    remove("source_switch_job_items");
    remove("source_switch_jobs");
    remove("state_sync_outbox", "status = 'completed'");
    remove("article_preprocessing_diagnostics");
    remove("ai_usage_events");
    remove("admin_audit_logs");
    remove("idempotency_requests");
    remove("reader_api_rate_limits");
    remove("gpt_oauth_authorization_codes");
    remove("thinking_events");
    remove("thinking_sessions");
  })();
  const violations = database.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) throw new Error(`Foreign-key validation failed after filtering: ${JSON.stringify(violations.slice(0, 20))}`);
  return removed;
}

function objectKeys(database: Database.Database): string[] {
  const keys = new Set<string>();
  const add = (tableName: string, names: string[], where = "") => {
    const available = columns(database, tableName);
    const selected = names.filter((name) => available.has(name));
    if (selected.length === 0) return;
    const sql = `SELECT ${selected.map((name) => `"${name}"`).join(",")} FROM "${tableName}" ${where}`;
    for (const row of database.prepare(sql).all() as Array<Record<string, unknown>>) {
      for (const name of selected) if (typeof row[name] === "string" && row[name]) keys.add(row[name] as string);
    }
  };
  add("articles", ["source_html_key", "source_text_key"]);
  add("source_items", ["upstream_content_key"]);
  add("translations", ["result_key", "content_html_key"], "WHERE status = 'completed'");
  return [...keys].sort();
}

interface ObjectReference {
  key: string;
  expectedBytes?: number;
  expectedSha256?: string;
}

function objectReferences(database: Database.Database): ObjectReference[] {
  const references = new Map<string, ObjectReference>();
  const add = (tableName: string, keyName: string, bytesName?: string, hashName?: string, where = "") => {
    const available = columns(database, tableName);
    if (!available.has(keyName)) return;
    const selections = [keyName, bytesName, hashName].filter((name): name is string => Boolean(name && available.has(name)));
    const rows = database.prepare(`SELECT ${selections.map((name) => `"${name}"`).join(",")} FROM "${tableName}" ${where}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const key = row[keyName];
      if (typeof key !== "string" || !key) continue;
      const candidate: ObjectReference = { key };
      if (bytesName && typeof row[bytesName] === "number") candidate.expectedBytes = row[bytesName] as number;
      if (hashName && typeof row[hashName] === "string" && row[hashName]) candidate.expectedSha256 = row[hashName] as string;
      const existing = references.get(key);
      if (existing && ((existing.expectedBytes != null && candidate.expectedBytes != null && existing.expectedBytes !== candidate.expectedBytes)
        || (existing.expectedSha256 && candidate.expectedSha256 && existing.expectedSha256 !== candidate.expectedSha256))) {
        throw new Error(`Conflicting database metadata for object: ${key}`);
      }
      references.set(key, { ...existing, ...candidate });
    }
  };
  add("articles", "source_html_key", "source_html_bytes", "source_html_hash");
  add("articles", "source_text_key", "source_text_bytes", "source_text_hash");
  add("source_items", "upstream_content_key");
  // translations.result_hash is the translation plan/source hash, not an
  // object checksum. result_bytes still validates the stored JSON payload.
  add("translations", "result_key", "result_bytes", undefined, "WHERE status = 'completed'");
  add("translations", "content_html_key", undefined, undefined, "WHERE status = 'completed'");
  return [...references.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function counts(database: Database.Database): Record<string, number> {
  const result: Record<string, number> = {};
  const names = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  for (const { name } of names) result[name] = Number((database.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number }).count);
  return result;
}

function importD1(): void {
  const dump = resolve(argument("dump"));
  const output = resolve(argument("output", runtimeConfig.databasePath));
  const reportRoot = resolve(argument("report", join(dirname(output), "migration-report")));
  if (!existsSync(dump)) throw new Error(`D1 dump does not exist: ${dump}`);
  if (existsSync(output)) throw new Error(`Refusing to overwrite an existing target database: ${output}`);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(reportRoot, { recursive: true });
  const temporary = `${output}.import-${Date.now()}`;
  const native = new Database(temporary);
  try {
    // D1 exports tables in an order that may insert child rows before a later
    // parent table is created. SQLite's default FK enforcement would reject
    // that valid export before we can run the final foreign-key check.
    native.pragma("foreign_keys = OFF");
    const restore = native.transaction((sql: string) => native.exec(sql));
    restore(readFileSync(dump, "utf8"));
    native.pragma("foreign_keys = ON");
    const required = ["accounts", "articles", "feeds", "translations", "prompt_versions", "ai_profile_versions"];
    const missing = required.filter((name) => !table(native, name));
    if (missing.length) throw new Error(`D1 export is not schema-compatible; missing: ${missing.join(", ")}`);
    const before = counts(native);
    const removed = sanitize(native);
    native.close();
    const local = new LocalDatabase(temporary);
    applyMigrations(local, [runtimeMigrations]);
    const insertMigration = local.native.prepare(`INSERT OR IGNORE INTO local_schema_migrations(source, name, applied_at)
      VALUES (?, ?, ?)`);
    for (const name of (awaitableMigrationNames())) insertMigration.run(businessMigrations.replaceAll("\\", "/"), name, new Date().toISOString());
    const after = counts(local.native);
    const keys = objectKeys(local.native);
    local.native.pragma("wal_checkpoint(TRUNCATE)");
    local.close();
    const databaseBytes = statSync(temporary).size;
    const databaseSha256 = createHash("sha256").update(readFileSync(temporary)).digest("hex");
    const sourceDumpSha256 = createHash("sha256").update(readFileSync(dump)).digest("hex");
    writeFileSync(join(reportRoot, "r2-manifest.txt"), `${keys.join("\n")}\n`, "utf8");
    writeFileSync(join(reportRoot, "database-report.json"), JSON.stringify({
      generatedAt: new Date().toISOString(), sourceDump: dump, sourceDumpSha256, target: output,
      databaseBytes, databaseSha256, before, after, removed, objectCount: keys.length,
    }, null, 2), "utf8");
    renameSync(temporary, output);
    console.log(JSON.stringify({ status: "imported", output, reportRoot, objectCount: keys.length }));
  } catch (error) {
    try { native.close(); } catch { /* already closed */ }
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function awaitableMigrationNames(): string[] {
  return readdirSync(businessMigrations, { encoding: "utf8" }).filter((name) => name.endsWith(".sql")).sort();
}

function verifyContent(): void {
  const database = new LocalDatabase(resolve(argument("database", runtimeConfig.databasePath)));
  const contentRoot = resolve(argument("content", runtimeConfig.contentRoot));
  const report = resolve(argument("report", join(dirname(database.native.name), "migration-report/content-report.json")));
  const metadataRepairs: Array<{ articleId: string; sourceTextHash: string; sourceTextBytes: number }> = [];
  if (table(database.native, "articles")) {
    const rows = database.native.prepare(`SELECT id, source_html_key AS htmlKey, source_html_hash AS htmlHash,
      source_text_key AS textKey, source_text_hash AS textHash, source_text_bytes AS textBytes
      FROM articles WHERE source_html_key IS NOT NULL AND source_text_key IS NOT NULL`).all() as Array<{
        id: string; htmlKey: string; htmlHash: string | null; textKey: string; textHash: string | null; textBytes: number | null;
      }>;
    const update = database.native.prepare("UPDATE articles SET source_text_hash = ?, source_text_bytes = ? WHERE id = ?");
    database.native.transaction(() => {
      for (const row of rows) {
        const htmlPath = safeObjectPath(contentRoot, row.htmlKey);
        const textPath = safeObjectPath(contentRoot, row.textKey);
        if (!existsSync(htmlPath) || !existsSync(textPath)) continue;
        const html = readFileSync(htmlPath, "utf8");
        const text = readFileSync(textPath, "utf8");
        const htmlHash = createHash("sha256").update(html).digest("hex");
        if (row.htmlHash && row.htmlHash !== htmlHash) continue;
        if (contentHtmlToText(html) !== text) continue;
        const textHash = createHash("sha256").update(text).digest("hex");
        const textBytes = Buffer.byteLength(text);
        if (row.textHash === textHash && row.textBytes === textBytes) continue;
        update.run(textHash, textBytes, row.id);
        metadataRepairs.push({ articleId: row.id, sourceTextHash: textHash, sourceTextBytes: textBytes });
      }
    })();
  }
  const references = objectReferences(database.native);
  const objects: Array<{ key: string; bytes: number; sha256: string }> = [];
  const missing: string[] = [];
  const mismatches: Array<{ key: string; field: string; expected: string | number; actual: string | number }> = [];
  for (const reference of references) {
    const path = safeObjectPath(contentRoot, reference.key);
    if (!existsSync(path)) { missing.push(reference.key); continue; }
    const data = readFileSync(path);
    const bytes = statSync(path).size;
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (reference.expectedBytes != null && reference.expectedBytes !== bytes) {
      mismatches.push({ key: reference.key, field: "bytes", expected: reference.expectedBytes, actual: bytes });
    }
    if (reference.expectedSha256 && reference.expectedSha256.toLowerCase() !== sha256) {
      mismatches.push({ key: reference.key, field: "sha256", expected: reference.expectedSha256, actual: sha256 });
    }
    objects.push({ key: reference.key, bytes, sha256 });
  }
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, JSON.stringify({ generatedAt: new Date().toISOString(), expected: references.length,
    present: objects.length, missing, mismatches, metadataRepairs, objects }, null, 2), "utf8");
  database.close();
  if (missing.length || mismatches.length) throw new Error(`Content validation failed: ${missing.length} missing, ${mismatches.length} mismatched; see ${report}`);
  console.log(JSON.stringify({ status: "verified", objects: objects.length, report }));
}

function r2Client(): { client: S3Client; endpoint: string; bucket: string } {
  const endpoint = argument("endpoint", process.env.R2_ENDPOINT ?? "https://841c2769e1a55cd93c7e23470de8bff7.r2.cloudflarestorage.com");
  const bucket = argument("bucket", process.env.R2_BUCKET ?? "feedmind-content");
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!accessKeyId || !secretAccessKey) throw new Error("R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required");
  return { endpoint, bucket, client: new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 3,
    retryMode: "standard",
  }) };
}

async function sendR2WithRetry<T>(label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} timed out after 60 seconds`));
        }, 60_000);
      });
      return await Promise.race([operation(controller.signal), timeout]);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw new Error(`${label} failed after 3 attempts`, { cause: lastError });
}

async function estimateR2(): Promise<void> {
  const { client, bucket } = r2Client();
  let continuationToken: string | undefined;
  let objectCount = 0;
  let bytes = 0;
  try {
    do {
      const page = continuationToken ?? "first page";
      const response = await sendR2WithRetry(`R2 list ${page}`, (signal) =>
        client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }), { abortSignal: signal }));
      for (const object of response.Contents ?? []) {
        objectCount += 1;
        bytes += object.Size ?? 0;
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    console.log(JSON.stringify({ status: "estimated", bucket, objectCount, bytes }));
  } finally {
    client.destroy();
  }
}

async function downloadR2(): Promise<void> {
  const manifest = resolve(argument("manifest"));
  const contentRoot = resolve(argument("content", runtimeConfig.contentRoot));
  const report = resolve(argument("report", join(dirname(manifest), "r2-download-report.json")));
  const { client, endpoint, bucket } = r2Client();
  if (!existsSync(manifest)) throw new Error(`R2 manifest does not exist: ${manifest}`);
  const keys = readFileSync(manifest, "utf8").split(/\r?\n/u).map((key) => key.trim()).filter(Boolean);
  const objects: Array<{ key: string; bytes: number; sha256: string; etag?: string }> = [];
  mkdirSync(contentRoot, { recursive: true });
  let nextIndex = 0;
  try {
    const downloadOne = async (key: string): Promise<void> => {
      const path = safeObjectPath(contentRoot, key);
      if (existsSync(path)) {
        const data = readFileSync(path);
        objects.push({ key, bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") });
        if (objects.length % 100 === 0 || objects.length === keys.length) {
          console.log(JSON.stringify({ status: "downloading", completed: objects.length, total: keys.length }));
        }
        return;
      }
      const downloaded = await sendR2WithRetry(`R2 download ${key}`, async (signal) => {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
        if (!response.Body) throw new Error(`R2 object has no body: ${key}`);
        return { data: await response.Body.transformToByteArray(), etag: response.ETag?.replaceAll('"', "") };
      });
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}`;
      writeFileSync(temporary, downloaded.data);
      renameSync(temporary, path);
      objects.push({ key, bytes: downloaded.data.byteLength,
        sha256: createHash("sha256").update(downloaded.data).digest("hex"), etag: downloaded.etag });
      if (objects.length % 100 === 0 || objects.length === keys.length) {
        console.log(JSON.stringify({ status: "downloading", completed: objects.length, total: keys.length }));
      }
    };
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= keys.length) return;
        await downloadOne(keys[index]);
      }
    };
    const concurrency = Math.min(16, keys.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    client.destroy();
  }
  objects.sort((left, right) => left.key.localeCompare(right.key));
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, JSON.stringify({ generatedAt: new Date().toISOString(), endpoint, bucket,
    objectCount: objects.length, objects }, null, 2), "utf8");
  console.log(JSON.stringify({ status: "downloaded", objects: objects.length, report }));
}

function bootstrap(): void {
  const database = new LocalDatabase(runtimeConfig.databasePath);
  const applied = applyMigrations(database, [businessMigrations, runtimeMigrations]);
  const violations = database.native.prepare("PRAGMA foreign_key_check").all();
  database.close();
  if (violations.length) throw new Error(`Foreign-key validation failed: ${JSON.stringify(violations)}`);
  console.log(JSON.stringify({ status: "ready", database: runtimeConfig.databasePath, applied }));
}

const command = process.argv[2] ?? "bootstrap";
if (command === "bootstrap") bootstrap();
else if (command === "import-d1") importD1();
else if (command === "download-r2") await downloadR2();
else if (command === "estimate-r2") await estimateR2();
else if (command === "verify-content") verifyContent();
else throw new Error(`Unknown migration command: ${command}`);
