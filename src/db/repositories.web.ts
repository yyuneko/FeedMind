import { getLocale } from '@/i18n';
import type { Locale } from '@/i18n';
import type { Article, ArticleFilter, ArticleState, Feed, Prompt, SyncPayload, Translation } from '@/types';
import { parseFeedCategories } from '@/utils/categories';
import { createLocalId } from '@/utils/id';
import { nowIso } from '@/utils/time';

type StoreName = 'feeds' | 'articles' | 'prompts' | 'translations' | 'articleStates' | 'settings';
type Setting = { key: string; value: string; updatedAt: string };

const DB_NAME = 'feedmind';
const DB_VERSION = 1;
const SECRET_PREFIX = 'feedmind:secret:';

let databasePromise: Promise<IDBDatabase> | null = null;

const requestResult = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

const transactionDone = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });

const openDatabase = () => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('feeds')) db.createObjectStore('feeds', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('articles')) db.createObjectStore('articles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('prompts')) db.createObjectStore('prompts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('translations')) db.createObjectStore('translations', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('articleStates')) db.createObjectStore('articleStates', { keyPath: 'articleId' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error('Unable to open IndexedDB'));
    };
  });
  return databasePromise;
};

const getOne = async <T>(storeName: StoreName, key: IDBValidKey) => {
  const db = await openDatabase();
  return requestResult(db.transaction(storeName).objectStore(storeName).get(key)) as Promise<T | undefined>;
};

const getAll = async <T>(storeName: StoreName) => {
  const db = await openDatabase();
  return requestResult(db.transaction(storeName).objectStore(storeName).getAll()) as Promise<T[]>;
};

const putOne = async <T>(storeName: StoreName, value: T) => {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
};

const deleteOne = async (storeName: StoreName, key: IDBValidKey) => {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
};

const clearStore = async (storeName: StoreName) => {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).clear();
  await transactionDone(transaction);
};

const defaultPrompts: Record<Locale, Array<Pick<Prompt, 'name' | 'content' | 'isDefault'>>> = {
  zh: [
    { name: '默认翻译', content: '请将下面的文章翻译成自然、准确、清晰的中文。保留必要的技术术语，不要扩写。', isDefault: true },
    { name: '技术文档风格', content: '请用技术文档风格翻译下面的内容，要求准确、克制、术语统一。', isDefault: false },
    { name: '儿童解释版', content: '请把下面的内容解释给小朋友听，语言简单，但不要遗漏关键信息。', isDefault: false },
  ],
  en: [
    { name: 'Default Translation', content: 'Translate the following article into natural, accurate, and clear English. Preserve necessary technical terms and do not expand the content.', isDefault: true },
    { name: 'Technical Documentation Style', content: 'Translate the following content in a technical documentation style. Keep it accurate, restrained, and consistent in terminology.', isDefault: false },
    { name: 'Explain to Children', content: 'Explain the following content to a child in simple language, without omitting key information.', isDefault: false },
  ],
  ja: [
    { name: 'デフォルト翻訳', content: '次の記事を自然で正確かつ明確な日本語に翻訳してください。必要な技術用語は保持し、内容を膨らませないでください。', isDefault: true },
    { name: '技術文書スタイル', content: '次の内容を技術文書の文体で翻訳してください。正確で控えめに、用語を統一してください。', isDefault: false },
    { name: '子ども向け説明', content: '次の内容を子どもに説明するように、簡単な言葉で説明してください。ただし重要な情報は省略しないでください。', isDefault: false },
  ],
};

export const ensureDefaultPrompts = async (locale: Locale = getLocale()) => {
  const initKey = 'defaultPromptsInitialized';
  if ((await settingsRepo.get(initKey)) === '1') return;
  if ((await promptRepo.list()).length === 0) {
    for (const item of defaultPrompts[locale]) await promptRepo.save(item);
  }
  await settingsRepo.set(initKey, '1');
};

export const feedRepo = {
  async list() {
    return (await getAll<Feed>('feeds')).sort((a, b) =>
      a.category.localeCompare(b.category) || a.title.localeCompare(b.title),
    );
  },
  async get(id: string) {
    return (await getOne<Feed>('feeds', id)) ?? null;
  },
  async upsert(feed: Feed) {
    const current = await getOne<Feed>('feeds', feed.id);
    await putOne('feeds', current ? { ...feed, createdAt: current.createdAt } : feed);
  },
  async remove(id: string) {
    const articles = (await getAll<Article>('articles')).filter((article) => article.feedId === id);
    const articleIds = new Set(articles.map((article) => article.id));
    const translations = await getAll<Translation>('translations');
    for (const translation of translations) {
      if (articleIds.has(translation.articleId)) await deleteOne('translations', translation.id);
    }
    for (const article of articles) {
      await deleteOne('articleStates', article.id);
      await deleteOne('articles', article.id);
    }
    await deleteOne('feeds', id);
  },
  async update(input: Pick<Feed, 'id' | 'title' | 'url' | 'siteUrl' | 'category'>) {
    const current = await getOne<Feed>('feeds', input.id);
    if (current) await putOne('feeds', { ...current, ...input, updatedAt: nowIso() });
  },
};

const articleTimestamp = (article: Article) => article.publishedAt ? new Date(article.publishedAt).getTime() : Number.NEGATIVE_INFINITY;
const sortArticles = (articles: Article[]) => articles.sort((a, b) =>
  articleTimestamp(b) - articleTimestamp(a) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
);

const withFeedTitle = (article: Article, feeds: Map<string, Feed>): Article => ({
  ...article,
  feedTitle: feeds.get(article.feedId)?.title,
  feedSiteUrl: feeds.get(article.feedId)?.siteUrl,
  feedUrl: feeds.get(article.feedId)?.url,
});

export const articleRepo = {
  async list(filter: ArticleFilter = 'all', category?: string, feedId?: string) {
    const feeds = new Map((await getAll<Feed>('feeds')).map((feed) => [feed.id, feed]));
    const articles = (await getAll<Article>('articles')).filter((article) => {
      if (filter === 'unread' && article.isRead) return false;
      if (filter === 'starred' && !article.isStarred) return false;
      if (feedId && article.feedId !== feedId) return false;
      const feed = feeds.get(article.feedId);
      return !category || parseFeedCategories(feed?.category).includes(category);
    });
    return sortArticles(articles).map((article) => withFeedTitle(article, feeds));
  },
  async get(id: string) {
    const article = await getOne<Article>('articles', id);
    if (!article) return null;
    const feed = await getOne<Feed>('feeds', article.feedId);
    return { ...article, feedTitle: feed?.title, feedSiteUrl: feed?.siteUrl, feedUrl: feed?.url };
  },
  async search(query: string) {
    const needle = query.toLocaleLowerCase();
    const feeds = new Map((await getAll<Feed>('feeds')).map((feed) => [feed.id, feed]));
    const articles = (await getAll<Article>('articles')).filter((article) =>
      article.title.toLocaleLowerCase().includes(needle) || article.contentText.toLocaleLowerCase().includes(needle),
    );
    return sortArticles(articles).map((article) => withFeedTitle(article, feeds));
  },
  async upsert(article: Article) {
    const current = await getOne<Article>('articles', article.id);
    await putOne('articles', current ? {
      ...current,
      ...article,
      isRead: current.isRead,
      isStarred: current.isStarred,
      createdAt: current.createdAt,
    } : article);
  },
  async updateContent(id: string, contentHtml: string, contentText: string) {
    const article = await getOne<Article>('articles', id);
    if (article) await putOne('articles', { ...article, contentHtml, contentText, updatedAt: nowIso() });
  },
  async setRead(id: string, isRead: boolean) {
    const article = await getOne<Article>('articles', id);
    if (!article) return;
    const updatedAt = nowIso();
    await putOne('articles', { ...article, isRead, updatedAt });
    const current = await getOne<ArticleState>('articleStates', id);
    await putOne('articleStates', { articleId: id, isRead, isStarred: current?.isStarred ?? article.isStarred, updatedAt });
  },
  async setStarred(id: string, isStarred: boolean) {
    const article = await getOne<Article>('articles', id);
    if (!article) return;
    const updatedAt = nowIso();
    await putOne('articles', { ...article, isStarred, updatedAt });
    const current = await getOne<ArticleState>('articleStates', id);
    await putOne('articleStates', { articleId: id, isRead: current?.isRead ?? article.isRead, isStarred, updatedAt });
  },
  async states() {
    return getAll<ArticleState>('articleStates');
  },
  async applyState(state: ArticleState) {
    await putOne('articleStates', state);
    const article = await getOne<Article>('articles', state.articleId);
    if (article) await putOne('articles', { ...article, isRead: state.isRead, isStarred: state.isStarred, updatedAt: state.updatedAt });
  },
};

export const promptRepo = {
  async list() {
    return (await getAll<Prompt>('prompts')).sort((a, b) =>
      Number(b.isDefault) - Number(a.isDefault) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  },
  async get(id: string) {
    return (await getOne<Prompt>('prompts', id)) ?? null;
  },
  async save(input: Pick<Prompt, 'name' | 'content' | 'isDefault'> & { id?: string }) {
    const updatedAt = nowIso();
    const id = input.id ?? await createLocalId(`prompt:${input.name}`);
    const current = await getOne<Prompt>('prompts', id);
    if (input.isDefault) {
      for (const prompt of await getAll<Prompt>('prompts')) {
        if (prompt.isDefault && prompt.id !== id) await putOne('prompts', { ...prompt, isDefault: false });
      }
    }
    await putOne('prompts', { ...input, id, createdAt: current?.createdAt ?? updatedAt, updatedAt });
    return id;
  },
  async upsert(prompt: Prompt) {
    if (prompt.isDefault) {
      for (const item of await getAll<Prompt>('prompts')) {
        if (item.isDefault && item.id !== prompt.id) await putOne('prompts', { ...item, isDefault: false });
      }
    }
    const current = await getOne<Prompt>('prompts', prompt.id);
    await putOne('prompts', current ? { ...prompt, createdAt: current.createdAt } : prompt);
  },
  async remove(id: string) {
    for (const translation of await getAll<Translation>('translations')) {
      if (translation.promptId === id) await deleteOne('translations', translation.id);
    }
    await deleteOne('prompts', id);
  },
  async replaceAll(prompts: Prompt[]) {
    await clearStore('translations');
    await clearStore('prompts');
    for (const prompt of prompts) await promptRepo.upsert(prompt);
  },
};

export const translationRepo = {
  async get(articleId: string, promptId: string) {
    return (await getAll<Translation>('translations')).find(
      (translation) => translation.articleId === articleId && translation.promptId === promptId,
    ) ?? null;
  },
  async save(articleId: string, promptId: string, content: string) {
    const current = await translationRepo.get(articleId, promptId);
    const updatedAt = nowIso();
    await putOne('translations', {
      id: current?.id ?? await createLocalId(`translation:${articleId}:${promptId}`),
      articleId,
      promptId,
      content,
      createdAt: current?.createdAt ?? updatedAt,
      updatedAt,
    });
  },
};

export const settingsRepo = {
  async get(key: string) {
    return (await getOne<Setting>('settings', key))?.value ?? '';
  },
  async set(key: string, value: string) {
    await putOne('settings', { key, value, updatedAt: nowIso() });
  },
  async getGithubToken() {
    return localStorage.getItem(`${SECRET_PREFIX}githubToken`);
  },
  async setGithubToken(value: string) {
    localStorage.setItem(`${SECRET_PREFIX}githubToken`, value);
  },
  async getDeepSeekApiKey() {
    return localStorage.getItem(`${SECRET_PREFIX}deepSeekApiKey`);
  },
  async setDeepSeekApiKey(value: string) {
    localStorage.setItem(`${SECRET_PREFIX}deepSeekApiKey`, value);
  },
};

export const syncRepo = {
  async exportPayload(): Promise<SyncPayload> {
    return {
      version: 1,
      updatedAt: nowIso(),
      feeds: await feedRepo.list(),
      articleStates: await articleRepo.states(),
      prompts: await promptRepo.list(),
    };
  },
  async applyPayload(payload: SyncPayload, options?: { replacePrompts?: boolean }) {
    const local = await syncRepo.exportPayload();
    for (const feed of mergeByUpdatedAt(local.feeds, payload.feeds)) await feedRepo.upsert(feed);
    if (options?.replacePrompts) await promptRepo.replaceAll(payload.prompts);
    else for (const prompt of mergeByUpdatedAt(local.prompts, payload.prompts)) await promptRepo.upsert(prompt);
    for (const state of mergeArticleStates(local.articleStates, payload.articleStates)) await articleRepo.applyState(state);
  },
};

const mergeByUpdatedAt = <T extends { id: string; updatedAt: string }>(local: T[], remote: T[]) => {
  const values = new Map<string, T>();
  for (const item of [...local, ...remote]) {
    const current = values.get(item.id);
    if (!current || new Date(item.updatedAt).getTime() >= new Date(current.updatedAt).getTime()) values.set(item.id, item);
  }
  return [...values.values()];
};

const mergeArticleStates = (local: ArticleState[], remote: ArticleState[]) => {
  const values = new Map<string, ArticleState>();
  for (const item of [...local, ...remote]) {
    const current = values.get(item.articleId);
    if (!current) {
      values.set(item.articleId, item);
      continue;
    }
    const newer = new Date(item.updatedAt).getTime() >= new Date(current.updatedAt).getTime() ? item : current;
    values.set(item.articleId, {
      articleId: item.articleId,
      isRead: current.isRead || item.isRead,
      isStarred: newer.isStarred,
      updatedAt: newer.updatedAt,
    });
  }
  return [...values.values()];
};
