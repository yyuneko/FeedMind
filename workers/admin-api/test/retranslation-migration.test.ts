import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../../migrations/0025_multi_account_core.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../migrations/0034_admin_retranslation_versions.sql", import.meta.url), "utf8");
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function database() {
  // Exercise the real translations table and indexes in isolation from unrelated foreign-key tables.
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  databases.push(db);
  db.exec(schema.match(/CREATE TABLE translations \([\s\S]*?\n\);/)![0]);
  for (const name of ["translations_one_active_idx", "translations_version_idempotency_idx"]) {
    db.exec(schema.match(new RegExp(`CREATE UNIQUE INDEX ${name} [\\s\\S]*?;`))![0]);
  }
  return db;
}

function insert(db: DatabaseSync, id: string, status: string, reason = "admin_retranslate", parentId: string | null = null) {
  db.prepare(`INSERT INTO translations
    (id, owner_id, article_id, target_locale, article_type, status, source_hash,
     prompt_version_id, title_profile_version_id, body_profile_version_id,
     parent_translation_id, trigger_reason, created_by, request_id, created_at)
    VALUES (?, 'account-1', 'article-1', 'zh-CN', 'general', ?, 'source-1',
      'prompt-1', 'fast-1', 'quality-1', ?, ?, 'admin', 'request-1', '2026-09-26')`)
    .run(id, status, parentId, reason);
}

describe("admin retranslation version migration", () => {
  it.each(["failed", "cancelled", "completed", "superseded"])(
    "allows unchanged configuration after a %s translation while preserving history",
    (status) => {
      const db = database();
      insert(db, "original", status, "first_client_request");
      expect(() => insert(db, "retranslation", "pending", "admin_retranslate", "original"))
        .toThrow(/UNIQUE constraint failed/);

      db.exec(migration);
      insert(db, "retranslation", "pending", "admin_retranslate", "original");
      expect(db.prepare("SELECT status FROM translations WHERE id = 'original'").get())
        .toMatchObject({ status });
      expect(db.prepare("SELECT parent_translation_id FROM translations WHERE id = 'retranslation'").get())
        .toMatchObject({ parent_translation_id: "original" });

      db.exec("UPDATE translations SET status = 'completed' WHERE id = 'retranslation'");
      expect(() => insert(db, "next-retranslation", "pending", "admin_retranslate", "retranslation"))
        .not.toThrow();
    },
  );

  it.each(["pending", "running", "cancel_requested"])("still prevents a second job while one is %s", (status) => {
    const db = database();
    db.exec(migration);
    insert(db, "active", status);
    expect(() => insert(db, "concurrent", "pending")).toThrow(/UNIQUE constraint failed/);
  });

  it("preserves configuration idempotency for ordinary requests", () => {
    const db = database();
    db.exec(migration);
    insert(db, "original", "completed", "first_client_request");
    expect(() => insert(db, "duplicate", "pending", "first_gpt_action_request"))
      .toThrow(/UNIQUE constraint failed/);
  });
});
