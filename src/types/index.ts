export type ISODateString = string;

export type Feed = {
  id: string;
  feedId: string;
  title: string;
  url: string;
  siteUrl: string | null;
  category: string;
  articleCount?: number;
  fetchStatus?: 'pending' | 'fetching' | 'ok' | 'error';
  createdAt: ISODateString;
  updatedAt: ISODateString;
};

export type Article = {
  id: string;
  feedId: string;
  feedRecordId?: string;
  feedTitle?: string;
  feedCategory?: string;
  feedSiteUrl?: string | null;
  feedUrl?: string | null;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: ISODateString | null;
  thumbnailUrl?: string | null;
  contentHtml: string;
  contentText: string;
  parserVersion?: number;
  parseStatus?: 'pending' | 'parsing' | 'ok' | 'error';
  isRead: boolean;
  isStarred: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
};

export type Prompt = {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
};

export type Translation = {
  id: string;
  articleId: string;
  promptId: string;
  content: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
};

export type StoredTranslationV2 = {
  v: 2;
  title: string;
  sourceHash: string;
  promptHash: string;
  blocks: Array<[id: string, markup: string]>;
};

export type ArticleState = {
  articleId: string;
  isRead: boolean;
  isStarred: boolean;
  updatedAt: ISODateString;
};

export type ArticleFilter = 'all' | 'unread' | 'starred';

export type ReadingMode = 'original' | 'translation' | 'bilingual';

export type ReaderThemeMode = 'light' | 'dark' | 'system';

export type ReaderFont = 'system' | 'source-han-serif' | 'literata' | 'source-serif-4';

export type LanguageMode = 'system' | 'zh' | 'en' | 'ja';
