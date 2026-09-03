import * as SQLite from 'expo-sqlite';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export const getDb = async () => {
  dbPromise ??= SQLite.openDatabaseAsync('rssmind.db');
  const db = await dbPromise;
  await migrate(db);
  return db;
};

const migrate = async (db: SQLite.SQLiteDatabase) => {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    DROP TABLE IF EXISTS explanation_cards;
    DROP TABLE IF EXISTS translations;
    DROP TABLE IF EXISTS prompts;
    DROP TABLE IF EXISTS article_states;
    DROP TABLE IF EXISTS articles;
    DROP TABLE IF EXISTS feeds;
  `);
};
