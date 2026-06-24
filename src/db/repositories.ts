import * as SecureStore from 'expo-secure-store';
import { getDb, toBool, toInt } from './database';
import type { Article, ArticleFilter, ArticleState, Feed, Prompt, SyncPayload, Translation } from '@/types';
import { parseFeedCategories } from '@/utils/categories';
import { createLocalId } from '@/utils/id';
import { nowIso } from '@/utils/time';

type FeedRow = Feed;
type ArticleRow = Omit<Article, 'isRead' | 'isStarred'> & { isRead: number; isStarred: number; feedCategory?: string };
type PromptRow = Omit<Prompt, 'isDefault'> & { isDefault: number };
type TranslationRow = Translation;
type ArticleStateRow = Omit<ArticleState, 'isRead' | 'isStarred'> & { isRead: number; isStarred: number };

const mapArticle = (row: ArticleRow): Article => ({
  ...row,
  isRead: toBool(row.isRead),
  isStarred: toBool(row.isStarred),
});

const mapPrompt = (row: PromptRow): Prompt => ({
  ...row,
  isDefault: toBool(row.isDefault),
});

const mapArticleState = (row: ArticleStateRow): ArticleState => ({
  ...row,
  isRead: toBool(row.isRead),
  isStarred: toBool(row.isStarred),
});

export const ensureDefaultPrompts = async () => {
  const db = await getDb();
  const count = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM prompts');
  if (count?.count) return;
  const ts = nowIso();
  const prompts = [
    {
      name: '默认翻译',
      content: '请将下面的文章翻译成自然、准确、清晰的中文。保留必要的技术术语，不要扩写。',
      isDefault: true,
    },
    {
      name: '技术文档风格',
      content: '请用技术文档风格翻译下面的内容，要求准确、克制、术语统一。',
      isDefault: false,
    },
    {
      name: '儿童解释版',
      content: '请把下面的内容解释给小朋友听，语言简单，但不要遗漏关键信息。',
      isDefault: false,
    },
  ];
  for (const item of prompts) {
    await db.runAsync(
      'INSERT INTO prompts (id, name, content, isDefault, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      await createLocalId(`prompt:${item.name}`),
      item.name,
      item.content,
      toInt(item.isDefault),
      ts,
      ts,
    );
  }
};

export const feedRepo = {
  async list() {
    const db = await getDb();
    return db.getAllAsync<FeedRow>('SELECT * FROM feeds ORDER BY category ASC, title ASC');
  },
  async get(id: string) {
    const db = await getDb();
    return db.getFirstAsync<FeedRow>('SELECT * FROM feeds WHERE id = ?', id);
  },
  async upsert(feed: Feed) {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO feeds (id, title, url, siteUrl, category, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, url=excluded.url, siteUrl=excluded.siteUrl, category=excluded.category, updatedAt=excluded.updatedAt`,
      feed.id,
      feed.title,
      feed.url,
      feed.siteUrl,
      feed.category,
      feed.createdAt,
      feed.updatedAt,
    );
  },
  async remove(id: string) {
    const db = await getDb();
    await db.runAsync('DELETE FROM translations WHERE articleId IN (SELECT id FROM articles WHERE feedId = ?)', id);
    await db.runAsync('DELETE FROM article_states WHERE articleId IN (SELECT id FROM articles WHERE feedId = ?)', id);
    await db.runAsync('DELETE FROM articles WHERE feedId = ?', id);
    await db.runAsync('DELETE FROM feeds WHERE id = ?', id);
  },
  async update(input: Pick<Feed, 'id' | 'title' | 'url' | 'siteUrl' | 'category'>) {
    const db = await getDb();
    await db.runAsync(
      'UPDATE feeds SET title = ?, url = ?, siteUrl = ?, category = ?, updatedAt = ? WHERE id = ?',
      input.title,
      input.url,
      input.siteUrl,
      input.category,
      nowIso(),
      input.id,
    );
  },
};

export const articleRepo = {
  async list(filter: ArticleFilter = 'all', category?: string, feedId?: string) {
    const db = await getDb();
    const clauses = ['1=1'];
    const args: string[] = [];
    if (filter === 'unread') clauses.push('a.isRead = 0');
    if (filter === 'starred') clauses.push('a.isStarred = 1');
    if (feedId) {
      clauses.push('a.feedId = ?');
      args.push(feedId);
    }
    const rows = await db.getAllAsync<ArticleRow>(
      `SELECT a.*, f.title as feedTitle, f.category as feedCategory
       FROM articles a
       LEFT JOIN feeds f ON f.id = a.feedId
       WHERE ${clauses.join(' AND ')}
       ORDER BY COALESCE(a.publishedAt, a.createdAt) DESC`,
      ...args,
    );
    return rows.filter((row) => !category || parseFeedCategories(row.feedCategory).includes(category)).map(mapArticle);
  },
  async get(id: string) {
    const db = await getDb();
    const row = await db.getFirstAsync<ArticleRow>(
      `SELECT a.*, f.title as feedTitle FROM articles a LEFT JOIN feeds f ON f.id = a.feedId WHERE a.id = ?`,
      id,
    );
    return row ? mapArticle(row) : null;
  },
  async search(query: string) {
    const db = await getDb();
    const rows = await db.getAllAsync<ArticleRow>(
      `SELECT a.*, f.title as feedTitle
       FROM articles a LEFT JOIN feeds f ON f.id = a.feedId
       WHERE a.title LIKE ? OR a.contentText LIKE ?
       ORDER BY COALESCE(a.publishedAt, a.createdAt) DESC`,
      `%${query}%`,
      `%${query}%`,
    );
    return rows.map(mapArticle);
  },
  async upsert(article: Article) {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO articles (id, feedId, title, url, author, publishedAt, contentHtml, contentText, isRead, isStarred, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, url=excluded.url, author=excluded.author, publishedAt=excluded.publishedAt,
       contentHtml=excluded.contentHtml, contentText=excluded.contentText, updatedAt=excluded.updatedAt`,
      article.id,
      article.feedId,
      article.title,
      article.url,
      article.author,
      article.publishedAt,
      article.contentHtml,
      article.contentText,
      toInt(article.isRead),
      toInt(article.isStarred),
      article.createdAt,
      article.updatedAt,
    );
  },
  async updateContent(id: string, contentHtml: string, contentText: string) {
    const db = await getDb();
    await db.runAsync(
      'UPDATE articles SET contentHtml = ?, contentText = ?, updatedAt = ? WHERE id = ?',
      contentHtml,
      contentText,
      nowIso(),
      id,
    );
  },
  async setRead(id: string, isRead: boolean) {
    const db = await getDb();
    const ts = nowIso();
    await db.runAsync('UPDATE articles SET isRead = ?, updatedAt = ? WHERE id = ?', toInt(isRead), ts, id);
    await db.runAsync(
      `INSERT INTO article_states (articleId, isRead, isStarred, updatedAt)
       VALUES (?, ?, COALESCE((SELECT isStarred FROM articles WHERE id = ?), 0), ?)
       ON CONFLICT(articleId) DO UPDATE SET isRead=excluded.isRead, updatedAt=excluded.updatedAt`,
      id,
      toInt(isRead),
      id,
      ts,
    );
  },
  async setStarred(id: string, isStarred: boolean) {
    const db = await getDb();
    const ts = nowIso();
    await db.runAsync('UPDATE articles SET isStarred = ?, updatedAt = ? WHERE id = ?', toInt(isStarred), ts, id);
    await db.runAsync(
      `INSERT INTO article_states (articleId, isRead, isStarred, updatedAt)
       VALUES (?, COALESCE((SELECT isRead FROM articles WHERE id = ?), 0), ?, ?)
       ON CONFLICT(articleId) DO UPDATE SET isStarred=excluded.isStarred, updatedAt=excluded.updatedAt`,
      id,
      id,
      toInt(isStarred),
      ts,
    );
  },
  async states() {
    const db = await getDb();
    const rows = await db.getAllAsync<ArticleStateRow>('SELECT * FROM article_states');
    return rows.map(mapArticleState);
  },
  async applyState(state: ArticleState) {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO article_states (articleId, isRead, isStarred, updatedAt) VALUES (?, ?, ?, ?)
       ON CONFLICT(articleId) DO UPDATE SET isRead=excluded.isRead, isStarred=excluded.isStarred, updatedAt=excluded.updatedAt`,
      state.articleId,
      toInt(state.isRead),
      toInt(state.isStarred),
      state.updatedAt,
    );
    await db.runAsync(
      'UPDATE articles SET isRead = ?, isStarred = ?, updatedAt = ? WHERE id = ?',
      toInt(state.isRead),
      toInt(state.isStarred),
      state.updatedAt,
      state.articleId,
    );
  },
};

export const promptRepo = {
  async list() {
    const db = await getDb();
    const rows = await db.getAllAsync<PromptRow>('SELECT * FROM prompts ORDER BY isDefault DESC, updatedAt DESC');
    return rows.map(mapPrompt);
  },
  async get(id: string) {
    const db = await getDb();
    const row = await db.getFirstAsync<PromptRow>('SELECT * FROM prompts WHERE id = ?', id);
    return row ? mapPrompt(row) : null;
  },
  async save(input: Pick<Prompt, 'name' | 'content' | 'isDefault'> & { id?: string }) {
    const db = await getDb();
    const ts = nowIso();
    const id = input.id ?? (await createLocalId(`prompt:${input.name}`));
    if (input.isDefault) await db.runAsync('UPDATE prompts SET isDefault = 0');
    await db.runAsync(
      `INSERT INTO prompts (id, name, content, isDefault, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, content=excluded.content, isDefault=excluded.isDefault, updatedAt=excluded.updatedAt`,
      id,
      input.name,
      input.content,
      toInt(input.isDefault),
      ts,
      ts,
    );
    return id;
  },
  async upsert(prompt: Prompt) {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO prompts (id, name, content, isDefault, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, content=excluded.content, isDefault=excluded.isDefault, updatedAt=excluded.updatedAt`,
      prompt.id,
      prompt.name,
      prompt.content,
      toInt(prompt.isDefault),
      prompt.createdAt,
      prompt.updatedAt,
    );
  },
  async remove(id: string) {
    const db = await getDb();
    await db.runAsync('DELETE FROM translations WHERE promptId = ?', id);
    await db.runAsync('DELETE FROM prompts WHERE id = ?', id);
  },
};

export const translationRepo = {
  async get(articleId: string, promptId: string) {
    const db = await getDb();
    return db.getFirstAsync<TranslationRow>('SELECT * FROM translations WHERE articleId = ? AND promptId = ?', articleId, promptId);
  },
  async save(articleId: string, promptId: string, content: string) {
    const db = await getDb();
    const ts = nowIso();
    await db.runAsync(
      `INSERT INTO translations (id, articleId, promptId, content, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(articleId, promptId) DO UPDATE SET content=excluded.content, updatedAt=excluded.updatedAt`,
      await createLocalId(`translation:${articleId}:${promptId}`),
      articleId,
      promptId,
      content,
      ts,
      ts,
    );
  },
};

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
  async getGithubToken() {
    return SecureStore.getItemAsync('githubToken');
  },
  async setGithubToken(value: string) {
    await SecureStore.setItemAsync('githubToken', value);
  },
  async getDeepSeekApiKey() {
    return SecureStore.getItemAsync('deepSeekApiKey');
  },
  async setDeepSeekApiKey(value: string) {
    await SecureStore.setItemAsync('deepSeekApiKey', value);
  },
};

export const syncRepo = {
  async exportPayload(): Promise<SyncPayload> {
    await ensureDefaultPrompts();
    return {
      version: 1,
      updatedAt: nowIso(),
      feeds: await feedRepo.list(),
      articleStates: await articleRepo.states(),
      prompts: await promptRepo.list(),
    };
  },
  async applyPayload(payload: SyncPayload) {
    const local = await syncRepo.exportPayload();
    const feeds = mergeByUpdatedAt(local.feeds, payload.feeds);
    const prompts = mergeByUpdatedAt(local.prompts, payload.prompts);
    const states = mergeArticleStates(local.articleStates, payload.articleStates);
    for (const feed of feeds) await feedRepo.upsert(feed);
    for (const prompt of prompts) await promptRepo.upsert(prompt);
    for (const state of states) await articleRepo.applyState(state);
  },
};

const mergeByUpdatedAt = <T extends { id: string; updatedAt: string }>(local: T[], remote: T[]) => {
  const map = new Map<string, T>();
  for (const item of [...local, ...remote]) {
    const current = map.get(item.id);
    if (!current || new Date(item.updatedAt).getTime() >= new Date(current.updatedAt).getTime()) {
      map.set(item.id, item);
    }
  }
  return [...map.values()];
};

const mergeArticleStates = (local: ArticleState[], remote: ArticleState[]) => {
  const map = new Map<string, ArticleState>();
  for (const item of [...local, ...remote]) {
    const current = map.get(item.articleId);
    if (!current) {
      map.set(item.articleId, item);
      continue;
    }
    const newer = new Date(item.updatedAt).getTime() >= new Date(current.updatedAt).getTime() ? item : current;
    map.set(item.articleId, {
      articleId: item.articleId,
      isRead: current.isRead || item.isRead,
      isStarred: newer.isStarred,
      updatedAt: newer.updatedAt,
    });
  }
  return [...map.values()];
};
