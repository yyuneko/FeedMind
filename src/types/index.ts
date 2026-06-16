export type ISODateString = string;

export type Feed = {
  id: string;
  title: string;
  url: string;
  siteUrl: string | null;
  category: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
};

export type Article = {
  id: string;
  feedId: string;
  feedTitle?: string;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: ISODateString | null;
  contentHtml: string;
  contentText: string;
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

export type ArticleState = {
  articleId: string;
  isRead: boolean;
  isStarred: boolean;
  updatedAt: ISODateString;
};

export type SyncPayload = {
  version: 1;
  updatedAt: ISODateString;
  feeds: Feed[];
  articleStates: ArticleState[];
  prompts: Prompt[];
};

export type ArticleFilter = 'all' | 'unread' | 'starred';

export type ReadingMode = 'original' | 'translation' | 'bilingual';

export type ReaderThemeMode = 'light' | 'dark' | 'system';
