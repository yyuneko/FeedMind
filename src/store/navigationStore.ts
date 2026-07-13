import { create } from 'zustand';

export type SelectionScope = 'today' | 'feeds' | 'saved' | 'category';
export const parseSelectionScope = (value?: string | string[]) => {
  const scope = Array.isArray(value) ? value[0] : value;
  return scope === 'today' || scope === 'feeds' || scope === 'saved' || scope === 'category' ? scope : undefined;
};
export type FeedSourceSelection = {
  kind: 'all' | 'category' | 'feed';
  category?: string;
  feedId?: string;
  feedRecordId?: string;
  title: string;
};

type NavigationState = {
  articleIds: Record<SelectionScope, string | null>;
  articleOrigin: SelectionScope | null;
  articleOrigins: Record<string, SelectionScope>;
  articleFeedSources: Record<string, FeedSourceSelection>;
  feedSource: FeedSourceSelection | null;
  setArticleId: (scope: SelectionScope, articleId: string | null) => void;
  setFeedSource: (source: FeedSourceSelection | null) => void;
  restoreFeedArticle: (articleId: string, source: FeedSourceSelection) => void;
};

export const useNavigationStore = create<NavigationState>((set) => ({
  articleIds: { today: null, feeds: null, saved: null, category: null },
  articleOrigin: null,
  articleOrigins: {},
  articleFeedSources: {},
  feedSource: null,
  setArticleId: (scope, articleId) => set((state) => ({
    articleIds: { ...state.articleIds, [scope]: articleId },
    articleOrigin: articleId ? scope : state.articleOrigin === scope ? null : state.articleOrigin,
    articleOrigins: articleId ? { ...state.articleOrigins, [articleId]: scope } : state.articleOrigins,
    articleFeedSources: articleId && scope === 'feeds' && state.feedSource
      ? { ...state.articleFeedSources, [articleId]: state.feedSource }
      : state.articleFeedSources,
  })),
  setFeedSource: (feedSource) => set({ feedSource }),
  restoreFeedArticle: (articleId, source) => set((state) => ({
    articleIds: { ...state.articleIds, feeds: articleId },
    articleOrigin: 'feeds',
    articleOrigins: { ...state.articleOrigins, [articleId]: 'feeds' },
    articleFeedSources: { ...state.articleFeedSources, [articleId]: source },
    feedSource: source,
  })),
}));
