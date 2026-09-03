import { getDb } from './database';
import { nowIso } from '@/utils/time';

// Only device-local presentation preferences are cached here. Business data
// and translation results are authoritative in Cloudflare D1/R2.
export const settingsRepo = {
  async get(key: string) {
    const db = await getDb();
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    return row?.value ?? '';
  },
  async set(key: string, value: string) {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`,
      key,
      value,
      nowIso(),
    );
  },
};
