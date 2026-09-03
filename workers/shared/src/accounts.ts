import type { AccessIdentity } from "./auth";
import type { D1Database } from "./cloudflare";
import { ApiError } from "./http";

const ACCESS_PROVIDER = "cloudflare_access";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function subjectId(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject));
  return `account:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)}`;
}

async function ensureLocalSource(db: D1Database, accountId: string, timestamp: string): Promise<void> {
  const connectionId = `connection:direct-rss:${accountId}`;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO source_connections
      (id, owner_id, connector_type, name, sync_policy, capabilities_json, cursor_json, status, created_at, updated_at)
      VALUES (?1, ?2, 'direct_rss', 'Direct RSS', 'feedmind_primary',
        '{"categories":true,"incrementalCursor":true,"readState":false,"writeState":false}', '{}', 'ok', ?3, ?3)`)
      .bind(connectionId, accountId, timestamp),
    db.prepare(`INSERT OR IGNORE INTO account_source_selections
      (owner_id, active_connection_id, revision, updated_at) VALUES (?1, ?2, 1, ?3)`)
      .bind(accountId, connectionId, timestamp),
  ]);
}

async function linkedAccountId(db: D1Database, subject: string): Promise<string | null> {
  const linked = await db.prepare(`SELECT account_id AS accountId FROM account_identities
    WHERE provider = ?1 AND provider_subject = ?2`).bind(ACCESS_PROVIDER, subject)
    .first<{ accountId: string }>();
  return linked?.accountId ?? null;
}

/** Resolves the immutable identity link with one indexed read on ordinary requests. */
export async function resolveAccount(
  db: D1Database,
  identity: AccessIdentity,
): Promise<string> {
  const linked = await linkedAccountId(db, identity.subject);
  return linked ?? provisionAccount(db, identity);
}

async function provisionAccount(
  db: D1Database,
  identity: AccessIdentity,
): Promise<string> {
  const normalizedEmail = normalizeEmail(identity.email);
  if (!normalizedEmail) throw new ApiError(401, "identity_email_missing", "Access identity does not contain an email address");

  const now = new Date().toISOString();
  let account = await db.prepare(`SELECT id FROM accounts
    WHERE normalized_email = ?1 AND email_verified_at IS NOT NULL`).bind(normalizedEmail).first<{ id: string }>();
  if (!account?.id) {
    const accountId = await subjectId(identity.subject);
    await db.prepare(`INSERT OR IGNORE INTO accounts
      (id, email, normalized_email, email_verified_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?4, ?4)`)
      .bind(accountId, identity.email.trim(), normalizedEmail, now).run();
    account = await db.prepare(`SELECT id FROM accounts
      WHERE normalized_email = ?1 AND email_verified_at IS NOT NULL`).bind(normalizedEmail).first<{ id: string }>();
  }
  if (!account?.id) throw new ApiError(500, "account_creation_failed", "Unable to create the account");

  await db.prepare(`INSERT OR IGNORE INTO account_identities
    (provider, provider_subject, account_id, email_at_link, last_seen_email, linked_at, last_seen_at)
    VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?5)`)
    .bind(ACCESS_PROVIDER, identity.subject, account.id, identity.email.trim(), now).run();

  const resolved = await db.prepare(`SELECT account_id AS accountId FROM account_identities
    WHERE provider = ?1 AND provider_subject = ?2`).bind(ACCESS_PROVIDER, identity.subject)
    .first<{ accountId: string }>();
  if (resolved?.accountId) {
    await ensureLocalSource(db, resolved.accountId, now);
    return resolved.accountId;
  }

  const owner = await db.prepare(`SELECT provider_subject AS providerSubject FROM account_identities
    WHERE provider = ?1 AND account_id = ?2`).bind(ACCESS_PROVIDER, account.id)
    .first<{ providerSubject: string }>();
  if (owner?.providerSubject) {
    throw new ApiError(409, "account_identity_conflict", "This FeedMind account is already linked to another Access identity");
  }
  throw new ApiError(500, "account_link_failed", "Unable to link the Access identity");
}

/** Resolves an Access identity without ever using email as a mutable key. */
export async function ensureAccount(
  db: D1Database,
  identity: AccessIdentity,
): Promise<string> {
  return resolveAccount(db, identity);
}
