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
  contentHash?: string;
  parserVersion?: number;
  parseStatus?: 'pending' | 'parsing' | 'ok' | 'error';
  parseError?: string | null;
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

export type ThinkingStage = 'summary' | 'argument' | 'logic' | 'importance' | 'critique' | 'connection' | 'complete';
export type ThinkingSessionStatus = 'active' | 'completed' | 'abandoned';
export type ThinkingEventKind = 'question' | 'answer' | 'feedback' | 'hint' | 'explanation';

export type ThinkingCoverage = {
  summary: boolean;
  argument: boolean;
  logic: boolean;
  importance: boolean;
  critique: boolean;
  connection: boolean;
};

export type ThinkingReport = {
  articleCore: string;
  strengths: string;
  omissions: string;
  thinkingDepth: string;
  expressionIssues: string;
  completedRounds: number;
  completedAt: ISODateString;
};

export type ThinkingCoachState = {
  guide?: {
    core: string;
    claims: string[];
    evidence: string[];
    logic: string[];
    important: string[];
    ambiguities: string[];
    connections: string[];
  };
  coverage?: ThinkingCoverage;
  unknownCount?: number;
  responseLanguage?: string;
};

export type ThinkingEvent = {
  id: string;
  sequence: number;
  kind: ThinkingEventKind;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: ISODateString;
};

export type ThinkingSession = {
  id: string;
  articleId: string;
  articleContentHash: string;
  status: ThinkingSessionStatus;
  stage: ThinkingStage;
  completedRounds: number;
  coverage: ThinkingCoverage | Record<string, never>;
  coachState: ThinkingCoachState;
  report?: ThinkingReport | null;
  version: number;
  startedAt: ISODateString;
  completedAt?: ISODateString | null;
  updatedAt: ISODateString;
  events?: ThinkingEvent[];
};
