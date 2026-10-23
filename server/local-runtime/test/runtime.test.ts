import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalContentBucket, safeObjectPath } from "../src/content";
import { applyMigrations, LocalDatabase } from "../src/db";
import { LocalJobStore, LocalQueue, LocalWorkflowBinding, LocalWorkflowStep } from "../src/jobs";

const roots: string[] = [];
const temporary = () => {
  const root = mkdtempSync(join(tmpdir(), "feedmind-local-test-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeDatabase(): LocalDatabase {
  const database = new LocalDatabase(join(temporary(), "runtime.sqlite"));
  database.native.exec(`
    CREATE TABLE local_jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL, next_run_at TEXT NOT NULL, lease_owner TEXT,
      lease_expires_at TEXT, last_error TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE local_workflow_instances (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, params_json TEXT NOT NULL, status TEXT NOT NULL,
      result_json TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE local_workflow_steps (
      workflow_id TEXT NOT NULL REFERENCES local_workflow_instances(id) ON DELETE CASCADE,
      step_name TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL,
      result_json TEXT, last_error TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY(workflow_id, step_name)
    );
  `);
  return database;
}

describe("LocalDatabase", () => {
  it("binds D1-style numbered parameters and rolls back a failed batch", async () => {
    const database = new LocalDatabase(join(temporary(), "db.sqlite"));
    database.native.exec("CREATE TABLE values_table(id TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    await database.prepare("INSERT INTO values_table(id, value) VALUES (?1, ?2)").bind("one", 1).run();
    expect(await database.prepare("SELECT value FROM values_table WHERE id = ?1").bind("one").first()).toEqual({ value: 1 });
    await expect(database.batch([
      database.prepare("INSERT INTO values_table(id, value) VALUES (?1, ?2)").bind("two", 2),
      database.prepare("INSERT INTO values_table(id, value) VALUES (?1, ?2)").bind("one", 3),
    ])).rejects.toThrow();
    expect((database.native.prepare("SELECT COUNT(*) AS count FROM values_table").get() as { count: number }).count).toBe(1);
    database.close();
  });

  it("recognizes migration rows recorded under a different host path", () => {
    const root = temporary();
    const migrations = join(root, "workers", "migrations");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(join(migrations, "0001_initial.sql"), "CREATE TABLE feeds(id TEXT PRIMARY KEY);", "utf8");
    const database = new LocalDatabase(join(root, "db.sqlite"));
    database.native.exec(`
      CREATE TABLE feeds(id TEXT PRIMARY KEY);
      CREATE TABLE local_schema_migrations (
        source TEXT NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL,
        PRIMARY KEY (source, name)
      );
      INSERT INTO local_schema_migrations(source, name, applied_at)
      VALUES ('D:/old-checkout/workers/migrations', '0001_initial.sql', '2026-01-01T00:00:00.000Z');
    `);
    expect(applyMigrations(database, [migrations])).toEqual([]);
    expect(database.native.prepare("SELECT source FROM local_schema_migrations").pluck().get())
      .toBe("workers/migrations");
    database.close();
  });
});

describe("LocalContentBucket", () => {
  it("writes and reads objects while rejecting traversal", async () => {
    const root = temporary();
    const bucket = new LocalContentBucket(root);
    await bucket.put("articles/a/source.html", "你好 FeedMind");
    expect(await (await bucket.get("articles/a/source.html"))?.text()).toBe("你好 FeedMind");
    expect(readFileSync(join(root, "articles/a/source.html"), "utf8")).toBe("你好 FeedMind");
    expect(() => safeObjectPath(root, "../outside")).toThrow(/escapes/);
    await bucket.delete("articles/a/source.html");
    expect(await bucket.get("articles/a/source.html")).toBeNull();
  });
});

describe("local durable jobs and workflows", () => {
  it("deduplicates queue messages and recovers an expired lease", async () => {
    const database = runtimeDatabase();
    const jobs = new LocalJobStore(database, "worker-one");
    const queue = new LocalQueue(jobs, "feed");
    await queue.send({ requestId: "same", feedId: "feed-1" });
    await queue.send({ requestId: "same", feedId: "feed-1" });
    expect((database.native.prepare("SELECT COUNT(*) AS count FROM local_jobs").get() as { count: number }).count).toBe(1);
    const leased = jobs.lease(["feed"], -1);
    expect(leased?.kind).toBe("feed");
    expect(jobs.recoverExpiredLeases()).toBe(1);
    expect(jobs.lease(["feed"])?.id).toBe(leased?.id);
    database.close();
  });

  it("keeps distinct entities from the same request as separate queue jobs", async () => {
    const database = runtimeDatabase();
    const jobs = new LocalJobStore(database, "worker-one");
    const queue = new LocalQueue(jobs, "article");
    await queue.send({ requestId: "request-1", articleId: "article-1" });
    await queue.send({ requestId: "request-1", articleId: "article-2" });
    await queue.send({ requestId: "request-1", articleId: "article-1" });
    expect((database.native.prepare("SELECT COUNT(*) AS count FROM local_jobs").get() as { count: number }).count).toBe(2);
    database.close();
  });

  it("immediately recovers a running job after a worker restart", async () => {
    const database = runtimeDatabase();
    const firstWorker = new LocalJobStore(database, "worker-one");
    firstWorker.enqueue("feed", { feedId: "feed-1" }, "restart-job");
    const leased = firstWorker.lease(["feed"]);
    expect(leased).not.toBeNull();
    const restartedWorker = new LocalJobStore(database, "worker-two");
    expect(restartedWorker.recoverAllLeasesAfterRestart()).toBe(1);
    expect(restartedWorker.lease(["feed"])?.id).toBe(leased?.id);
    database.close();
  });

  it("checkpoints a completed workflow step", async () => {
    const database = runtimeDatabase();
    const jobs = new LocalJobStore(database);
    const workflows = new LocalWorkflowBinding(database, jobs, "translation");
    await workflows.create({ id: "workflow-1", params: { translationId: "t1" } });
    const step = new LocalWorkflowStep(database, "workflow-1");
    let calls = 0;
    expect(await step.do("once", async () => ({ value: ++calls }))).toEqual({ value: 1 });
    expect(await step.do("once", async () => ({ value: ++calls }))).toEqual({ value: 1 });
    expect(calls).toBe(1);
    database.close();
  });

  it("persists workflow cancellation and refuses later steps", async () => {
    const database = runtimeDatabase();
    const jobs = new LocalJobStore(database);
    const workflows = new LocalWorkflowBinding(database, jobs, "translation");
    const instance = await workflows.create({ id: "workflow-cancelled", params: {} });
    await instance.terminate();
    const step = new LocalWorkflowStep(database, "workflow-cancelled");
    await expect(step.do("after-cancel", async () => "unexpected")).rejects.toThrow(/cancelled/);
    await expect(instance.status()).resolves.toMatchObject({ status: "cancelled" });
    database.close();
  });
});
