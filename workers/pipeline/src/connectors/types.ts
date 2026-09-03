export type ConnectorType = "direct_rss" | "google_reader";
export type SyncPolicy = "feedmind_primary" | "upstream_primary" | "bidirectional";

export interface ConnectorCapabilities {
  categories: boolean;
  incrementalCursor: boolean;
  readState: boolean;
  writeState: boolean;
}

export interface ConnectorContext {
  baseUrl: string;
  credentials: Record<string, string>;
  fetcher?: typeof fetch;
}

export interface DiscoveredSource {
  externalId: string;
  kind: "feed";
  title: string;
  url: string | null;
  siteUrl: string | null;
  categories: string[];
}

export interface NormalizedSourceItem {
  externalItemId: string;
  sourceExternalId: string;
  canonicalUrl: string | null;
  title: string;
  author: string;
  summary: string;
  upstreamHtml: string;
  publishedAt: string | null;
  updatedAt: string | null;
  isRead: boolean | null;
  isSaved: boolean | null;
}

export interface PullItemsResult {
  items: NormalizedSourceItem[];
  cursor: Record<string, unknown>;
  hasMore: boolean;
}

export interface StateMutation {
  externalItemId: string;
  isRead?: boolean;
  isSaved?: boolean;
}

export interface SubscriptionMutation {
  action: "subscribe" | "unsubscribe" | "edit";
  externalId?: string;
  url?: string;
  title?: string;
  categories?: string[];
}

export interface SourceConnector {
  readonly type: ConnectorType;
  readonly capabilities: ConnectorCapabilities;
  testConnection(context: ConnectorContext): Promise<ConnectorCapabilities>;
  discoverSources(context: ConnectorContext): Promise<DiscoveredSource[]>;
  pullItems(context: ConnectorContext, cursor: Record<string, unknown>): Promise<PullItemsResult>;
  pullStates(context: ConnectorContext, externalItemIds: string[]): Promise<Map<string, { isRead: boolean; isSaved: boolean }>>;
  pushStates(context: ConnectorContext, mutations: StateMutation[]): Promise<void>;
  pushSubscriptions(context: ConnectorContext, mutations: SubscriptionMutation[]): Promise<void>;
}
