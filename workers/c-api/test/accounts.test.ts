import { describe, expect, it } from "vitest";
import { ensureAccount, resolveAccount } from "../../shared/src/accounts";
import type { D1Database, D1PreparedStatement } from "../../shared/src/cloudflare";
import { ApiError } from "../../shared/src/http";

interface AccountRow {
  id: string;
  normalizedEmail: string | null;
  verified: boolean;
}

interface IdentityRow {
  provider: string;
  subject: string;
  accountId: string;
  lastSeenEmail: string;
}

function database(initialAccounts: AccountRow[] = [], initialIdentities: IdentityRow[] = []) {
  const accounts = [...initialAccounts];
  const identities = [...initialIdentities];
  const calls = { first: 0, run: 0, batch: 0 };
  const db: D1Database = {
    prepare(sql: string): D1PreparedStatement {
      let bindings: unknown[] = [];
      const statement: D1PreparedStatement = {
        bind(...values: unknown[]) { bindings = values; return statement; },
        async first<T>() {
          calls.first += 1;
          if (sql.includes("account_identities") && sql.includes("provider_subject = ?2")) {
            const row = identities.find((item) => item.provider === bindings[0] && item.subject === bindings[1]);
            return (row ? { accountId: row.accountId } : null) as T | null;
          }
          if (sql.includes("FROM accounts") && sql.includes("normalized_email")) {
            const row = accounts.find((item) => item.normalizedEmail === bindings[0] && item.verified);
            return (row ? { id: row.id } : null) as T | null;
          }
          if (sql.includes("account_identities") && sql.includes("account_id = ?2")) {
            const row = identities.find((item) => item.provider === bindings[0] && item.accountId === bindings[1]);
            return (row ? { providerSubject: row.subject } : null) as T | null;
          }
          return null;
        },
        async all<T>() { return { success: true, results: [] as T[] }; },
        async run() {
          calls.run += 1;
          if (sql.startsWith("UPDATE account_identities")) {
            const row = identities.find((item) => item.provider === bindings[2] && item.subject === bindings[3]);
            if (row) row.lastSeenEmail = String(bindings[0]);
          } else if (sql.includes("INSERT OR IGNORE INTO accounts")) {
            const normalizedEmail = String(bindings[2]);
            if (!accounts.some((item) => item.verified && item.normalizedEmail === normalizedEmail)) {
              accounts.push({ id: String(bindings[0]), normalizedEmail, verified: true });
            }
          } else if (sql.includes("INSERT OR IGNORE INTO account_identities")) {
            const provider = String(bindings[0]);
            const subject = String(bindings[1]);
            const accountId = String(bindings[2]);
            if (!identities.some((item) => (item.provider === provider && item.subject === subject)
              || (item.provider === provider && item.accountId === accountId))) {
              identities.push({ provider, subject, accountId, lastSeenEmail: String(bindings[3]) });
            }
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch() { calls.batch += 1; return []; },
  };
  return { db, accounts, identities, calls };
}

describe("Access account linking", () => {
  it("claims a verified legacy account by normalized email exactly once", async () => {
    const state = database([{ id: "legacy-user-1", normalizedEmail: "alice@example.com", verified: true }]);

    await expect(ensureAccount(state.db, { subject: "access-sub-1", email: " Alice@Example.com " }))
      .resolves.toBe("legacy-user-1");
    expect(state.identities).toEqual([expect.objectContaining({
      provider: "cloudflare_access", subject: "access-sub-1", accountId: "legacy-user-1",
    })]);

    await expect(ensureAccount(state.db, { subject: "access-sub-1", email: "renamed@example.com" }))
      .resolves.toBe("legacy-user-1");
    expect(state.accounts).toHaveLength(1);
    expect(state.calls.run).toBe(1);
    expect(state.calls.batch).toBe(1);
  });

  it("does not auto-claim an unverified legacy email", async () => {
    const state = database([{ id: "unverified-user", normalizedEmail: "alice@example.com", verified: false }]);
    const accountId = await ensureAccount(state.db, { subject: "access-sub-1", email: "alice@example.com" });

    expect(accountId).not.toBe("unverified-user");
    expect(state.identities[0]?.accountId).toBe(accountId);
  });

  it("rejects a second Access identity trying to claim the same account", async () => {
    const state = database(
      [{ id: "legacy-user-1", normalizedEmail: "alice@example.com", verified: true }],
      [{ provider: "cloudflare_access", subject: "access-sub-1", accountId: "legacy-user-1", lastSeenEmail: "alice@example.com" }],
    );

    await expect(ensureAccount(state.db, { subject: "access-sub-2", email: "alice@example.com" }))
      .rejects.toMatchObject({ status: 409, code: "account_identity_conflict" } satisfies Partial<ApiError>);
  });

  it("resolves an existing identity without repeating account or source initialization", async () => {
    const state = database(
      [{ id: "account-1", normalizedEmail: "alice@example.com", verified: true }],
      [{ provider: "cloudflare_access", subject: "access-sub-1", accountId: "account-1", lastSeenEmail: "alice@example.com" }],
    );

    await expect(resolveAccount(state.db, { subject: "access-sub-1", email: "alice@example.com" }))
      .resolves.toBe("account-1");
    expect(state.calls).toEqual({ first: 1, run: 0, batch: 0 });
  });
});
