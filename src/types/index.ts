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

export type SourceConnection = {
  id: string;
  type: 'direct_rss' | 'google_reader';
  name: string;
  baseUrl: string | null;
  syncPolicy: 'feedmind_primary' | 'upstream_primary' | 'bidirectional';
  capabilities: { categories: boolean; incrementalCursor: boolean; readState: boolean; writeState: boolean };
  status: 'pending' | 'syncing' | 'ok' | 'error' | 'disabled';
  lastErrorCode?: string | null;
  lastSyncedAt?: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  isActive?: boolean;
};

export type SourceSwitchJob = {
  id: string;
  fromConnectionId: string;
  toConnectionId: string;
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'superseded';
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  lastErrorCode?: string | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
};

export type SourceSelection = {
  connection: Pick<SourceConnection, 'id' | 'type' | 'name' | 'status'> | null;
  revision: number;
  job?: SourceSwitchJob | null;
};

export type ReaderCredential = {
  id: string;
  name: string;
  loginName: string;
  createdAt: ISODateString;
  lastUsedAt?: ISODateString | null;
};

export type Source = {
  id: string;
  connectionId: string;
  kind: 'feed';
  title: string;
  url: string | null;
  siteUrl: string | null;
  categories: string[];
  enabled: boolean;
  syncStatus: 'pending' | 'syncing' | 'ok' | 'error' | 'disabled';
  lastErrorCode?: string | null;
  lastSyncedAt?: ISODateString | null;
  articleCount: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
};

export type LibraryFeed = {
  id: string;
  categoryId: string | null;
  subscriptionId?: string | null;
  title: string;
  url: string | null;
  siteUrl: string | null;
  enabled: boolean;
  syncStatus: Source['syncStatus'];
  lastErrorCode?: string | null;
  sortOrder: number;
  connectorType: 'direct_rss' | 'google_reader';
  editableUrl: boolean;
  articleCount: number;
  unreadCount: number;
};

export type LibraryCategory = {
  id: string;
  name: string;
  sortOrder: number;
  unreadCount: number;
  feeds: LibraryFeed[];
};

export type LibraryTree = {
  unreadCount: number;
  categories: LibraryCategory[];
  uncategorized: { id: null; unreadCount: number; feeds: LibraryFeed[] };
};

export type ArticleSourceSummary = Pick<Source, 'id' | 'connectionId' | 'kind' | 'title' | 'url'>;

export type Article = {
  id: string;
  feedId: string;
  feedRecordId?: string;
  feedTitle?: string;
  feedCategory?: string;
  feedSiteUrl?: string | null;
  feedUrl?: string | null;
  title: string;
  translatedTitle?: string | null;
  sourceTitleLocale?: 'zh-CN' | 'en-US' | 'ja-JP' | 'other' | null;
  translatedTitleLocale?: 'zh-CN' | 'en-US' | 'ja-JP' | null;
  oneLineSummary?: string | null;
  keyPoints?: string[];
  informationScore?: number | null;
  informationScoreDimensions?: Record<string, number> | null;
  informationScoreReason?: string | null;
  topicTags?: Array<{ key: string; name: string }>;
  preprocessingStatus?: 'pending' | 'running' | 'completed' | 'failed' | 'content_too_large' | 'missing';
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
  isSelected?: boolean;
  isRead: boolean;
  isStarred: boolean;
  progress?: number;
  lastOpenedAt?: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  sources?: ArticleSourceSummary[];
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

export type ArticleCollection =
  | { kind: 'all' }
  | { kind: 'recent' }
  | { kind: 'saved' }
  | { kind: 'category'; categoryId: string }
  | { kind: 'feed'; sourceId: string };

export type ArticleListCriteria = {
  collection: ArticleCollection;
  unreadOnly: boolean;
  tagKey?: string;
  query: string;
};

export type ArticleTagOption = { key: string; name: string; count: number };

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
