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

    CREATE TABLE IF NOT EXISTS feeds (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      siteUrl TEXT,
      category TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY NOT NULL,
      feedId TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      author TEXT,
      publishedAt TEXT,
      contentHtml TEXT NOT NULL,
      contentText TEXT NOT NULL,
      isRead INTEGER NOT NULL DEFAULT 0,
      isStarred INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      isDefault INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS translations (
      id TEXT PRIMARY KEY NOT NULL,
      articleId TEXT NOT NULL,
      promptId TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(articleId, promptId)
    );

    CREATE TABLE IF NOT EXISTS article_states (
      articleId TEXT PRIMARY KEY NOT NULL,
      isRead INTEGER NOT NULL DEFAULT 0,
      isStarred INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
};

export const toBool = (value: number | boolean) => Boolean(value);
export const toInt = (value: boolean) => (value ? 1 : 0);
