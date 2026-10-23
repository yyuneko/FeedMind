import type { Queue, WorkflowBinding, WorkflowInstance } from "../../../workers/shared/src/cloudflare";
import type { LocalDatabase } from "./db";

export interface LocalJob<T = unknown> {
  id: string;
  kind: string;
  payload: T;
  attemptCount: number;
  maxAttempts: number;
}

const now = () => new Date().toISOString();

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

function delayMilliseconds(value: unknown): number {
  if (typeof value !== "string") return 0;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(millisecond|second|minute|hour)s?$/i);
  if (!match) return 0;
  const multiplier = { millisecond: 1, second: 1000, minute: 60_000, hour: 3_600_000 }[match[2].toLowerCase()];
  return Number(match[1]) * multiplier!;
}

export class LocalJobStore {
  constructor(private readonly database: LocalDatabase, private readonly owner = `${process.pid}-${crypto.randomUUID()}`) {}

  enqueue(kind: string, payload: unknown, dedupeKey: string, maximumAttempts = 5, runAt = now()): string {
    const id = crypto.randomUUID();
    this.database.native.prepare(`INSERT OR IGNORE INTO local_jobs
      (id, kind, dedupe_key, payload_json, status, attempt_count, max_attempts, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`).run(
      id, kind, dedupeKey, JSON.stringify(payload), maximumAttempts, runAt, now(), now(),
    );
    const row = this.database.native.prepare("SELECT id FROM local_jobs WHERE dedupe_key = ?").get(dedupeKey) as { id: string };
    return row.id;
  }

  recoverExpiredLeases(): number {
    return this.database.native.prepare(`UPDATE local_jobs SET status = 'pending', lease_owner = NULL,
      lease_expires_at = NULL, next_run_at = ?, updated_at = ?, last_error = 'worker_lease_expired'
      WHERE status = 'running' AND lease_expires_at <= ?`).run(now(), now(), now()).changes;
  }

  recoverAllLeasesAfterRestart(): number {
    return this.database.native.prepare(`UPDATE local_jobs SET status = 'pending', lease_owner = NULL,
      lease_expires_at = NULL, next_run_at = ?, updated_at = ?, last_error = 'worker_restarted'
      WHERE status = 'running'`).run(now(), now()).changes;
  }

  lease(kinds: string[], leaseSeconds = 900): LocalJob | null {
    if (kinds.length === 0) return null;
    const placeholders = kinds.map(() => "?").join(",");
    const timestamp = now();
    const expires = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const row = this.database.native.prepare(`UPDATE local_jobs
      SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
      WHERE id = (SELECT id FROM local_jobs WHERE status = 'pending' AND next_run_at <= ?
        AND kind IN (${placeholders}) ORDER BY next_run_at, created_at LIMIT 1)
      RETURNING id, kind, payload_json AS payloadJson, attempt_count AS attemptCount, max_attempts AS maxAttempts`)
      .get(this.owner, expires, timestamp, timestamp, ...kinds) as {
        id: string; kind: string; payloadJson: string; attemptCount: number; maxAttempts: number;
      } | undefined;
    return row ? { id: row.id, kind: row.kind, payload: JSON.parse(row.payloadJson),
      attemptCount: row.attemptCount, maxAttempts: row.maxAttempts } : null;
  }

  complete(id: string): void {
    this.database.native.prepare(`UPDATE local_jobs SET status = 'completed', lease_owner = NULL,
      lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ?`)
      .run(now(), now(), id, this.owner);
  }

  fail(job: LocalJob, error: unknown, delaySeconds?: number): void {
    const terminal = job.attemptCount >= job.maxAttempts;
    const seconds = delaySeconds ?? Math.min(3600, 15 * 2 ** Math.min(Math.max(job.attemptCount - 1, 0), 8));
    const next = new Date(Date.now() + seconds * 1000).toISOString();
    this.database.native.prepare(`UPDATE local_jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
      next_run_at = ?, last_error = ?, completed_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ?`)
      .run(terminal ? "failed" : "pending", next, errorMessage(error), terminal ? now() : null, now(), job.id, this.owner);
  }
}

export class LocalQueue<T = unknown> implements Queue<T> {
  constructor(private readonly jobs: LocalJobStore, private readonly kind: string) {}

  async send(message: T): Promise<void> {
    const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
    const identityFields = ["id", "feedId", "articleId", "taskId", "connectionId", "switchJobId",
      "translationId", "attemptId", "sourceId", "requestId"];
    const identityParts = identityFields
      .filter((field) => record[field] != null && String(record[field]).length > 0)
      .map((field) => `${field}=${String(record[field])}`);
    const identity = identityParts.length > 0 ? identityParts.join("|") : crypto.randomUUID();
    this.jobs.enqueue(this.kind, message, `${this.kind}:${identity}`);
  }
}

class LocalWorkflowInstance implements WorkflowInstance {
  constructor(private readonly database: LocalDatabase, private readonly jobs: LocalJobStore, readonly id: string) {}

  async status(): Promise<unknown> {
    return this.database.native.prepare("SELECT status, last_error AS error, updated_at AS updatedAt FROM local_workflow_instances WHERE id = ?")
      .get(this.id) ?? { status: "unknown" };
  }

  async restart(): Promise<void> {
    const row = this.database.native.prepare("SELECT kind, params_json AS paramsJson FROM local_workflow_instances WHERE id = ?")
      .get(this.id) as { kind: string; paramsJson: string } | undefined;
    if (!row) throw new Error("Workflow instance not found");
    this.database.native.prepare(`UPDATE local_workflow_instances SET status = 'pending', last_error = NULL,
      completed_at = NULL, updated_at = ? WHERE id = ?`).run(now(), this.id);
    this.jobs.enqueue(`workflow:${row.kind}`, { workflowId: this.id }, `workflow-restart:${this.id}:${Date.now()}`, 1);
  }

  async terminate(): Promise<void> {
    this.database.native.transaction(() => {
      this.database.native.prepare(`UPDATE local_workflow_instances SET status = 'cancelled', completed_at = ?, updated_at = ?
        WHERE id = ? AND status NOT IN ('completed', 'cancelled')`).run(now(), now(), this.id);
      this.database.native.prepare(`UPDATE local_jobs SET status = 'cancelled', completed_at = ?, updated_at = ?
        WHERE json_extract(payload_json, '$.workflowId') = ? AND status = 'pending'`).run(now(), now(), this.id);
    })();
  }
}

export class LocalWorkflowBinding<T = unknown> implements WorkflowBinding<T> {
  constructor(private readonly database: LocalDatabase, private readonly jobs: LocalJobStore, private readonly kind: string) {}

  async create(options: { id?: string; params?: T } = {}): Promise<WorkflowInstance> {
    const id = options.id ?? crypto.randomUUID();
    const inserted = this.database.native.prepare(`INSERT OR IGNORE INTO local_workflow_instances
      (id, kind, params_json, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`)
      .run(id, this.kind, JSON.stringify(options.params ?? {}), now(), now());
    if (inserted.changes === 0) throw new Error(`Workflow instance already exists: ${id}`);
    this.jobs.enqueue(`workflow:${this.kind}`, { workflowId: id }, `workflow:${id}`, 1);
    return new LocalWorkflowInstance(this.database, this.jobs, id);
  }

  async get(id: string): Promise<WorkflowInstance> {
    return new LocalWorkflowInstance(this.database, this.jobs, id);
  }
}

export class LocalWorkflowStep {
  constructor(private readonly database: LocalDatabase, private readonly workflowId: string) {}

  async do<T>(name: string, optionsOrCallback: unknown, maybeCallback?: () => Promise<T>): Promise<T> {
    const instance = this.database.native.prepare("SELECT status FROM local_workflow_instances WHERE id = ?")
      .get(this.workflowId) as { status: string } | undefined;
    if (!instance) throw new Error(`Workflow instance not found: ${this.workflowId}`);
    if (instance.status === "cancelled") throw new Error(`Workflow instance is cancelled: ${this.workflowId}`);
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback as () => Promise<T> : maybeCallback;
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback as {
      retries?: { limit?: number; delay?: string; backoff?: string }; timeout?: string;
    };
    if (!callback) throw new TypeError("Workflow step callback is required");
    const existing = this.database.native.prepare(`SELECT status, result_json AS resultJson FROM local_workflow_steps
      WHERE workflow_id = ? AND step_name = ?`).get(this.workflowId, name) as { status: string; resultJson: string | null } | undefined;
    if (existing?.status === "completed") return JSON.parse(existing.resultJson ?? "null") as T;
    const maximumAttempts = Number(options.retries?.limit ?? 0) + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
      this.database.native.prepare(`INSERT INTO local_workflow_steps
        (workflow_id, step_name, status, attempt_count, started_at, updated_at)
        VALUES (?, ?, 'running', 1, ?, ?)
        ON CONFLICT(workflow_id, step_name) DO UPDATE SET status = 'running',
          attempt_count = attempt_count + 1, started_at = excluded.started_at, updated_at = excluded.updated_at`)
        .run(this.workflowId, name, now(), now());
      try {
        const timeout = delayMilliseconds(options.timeout);
        const result = timeout > 0
          ? await Promise.race([callback(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Workflow step timed out: ${name}`)), timeout))])
          : await callback();
        this.database.native.prepare(`UPDATE local_workflow_steps SET status = 'completed', result_json = ?,
          last_error = NULL, completed_at = ?, updated_at = ? WHERE workflow_id = ? AND step_name = ?`)
          .run(JSON.stringify(result ?? null), now(), now(), this.workflowId, name);
        return result;
      } catch (error) {
        lastError = error;
        this.database.native.prepare(`UPDATE local_workflow_steps SET status = 'failed', last_error = ?, updated_at = ?
          WHERE workflow_id = ? AND step_name = ?`).run(errorMessage(error), now(), this.workflowId, name);
        if (attempt < maximumAttempts) {
          const base = delayMilliseconds(options.retries?.delay);
          const delay = options.retries?.backoff === "exponential" ? base * 2 ** (attempt - 1) : base;
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }
}

export function workflowPayload(database: LocalDatabase, id: string): { kind: string; params: unknown; status: string } {
  const row = database.native.prepare(`SELECT kind, params_json AS paramsJson, status FROM local_workflow_instances WHERE id = ?`)
    .get(id) as { kind: string; paramsJson: string; status: string } | undefined;
  if (!row) throw new Error(`Workflow instance not found: ${id}`);
  return { kind: row.kind, params: JSON.parse(row.paramsJson), status: row.status };
}

export function startWorkflow(database: LocalDatabase, id: string): void {
  database.native.prepare(`UPDATE local_workflow_instances SET status = 'running', updated_at = ?
    WHERE id = ? AND status IN ('pending', 'failed')`).run(now(), id);
}

export function finishWorkflow(database: LocalDatabase, id: string, result: unknown): void {
  database.native.prepare(`UPDATE local_workflow_instances SET status = 'completed', result_json = ?,
    last_error = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status <> 'cancelled'`).run(JSON.stringify(result ?? null), now(), now(), id);
}

export function failWorkflow(database: LocalDatabase, id: string, error: unknown): void {
  database.native.prepare(`UPDATE local_workflow_instances SET status = 'failed', last_error = ?,
    completed_at = ?, updated_at = ? WHERE id = ? AND status <> 'cancelled'`).run(errorMessage(error), now(), now(), id);
}
