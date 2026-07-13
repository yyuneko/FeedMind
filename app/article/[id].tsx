import { ArticleDetailScreen } from '@/screens/ArticleDetailScreen';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ArticleListScreen } from '@/screens/ArticleListScreen';
import { FeedsScreen } from '@/screens/FeedsScreen';
import { SavedScreen } from '@/screens/SavedScreen';
import { TodayScreen } from '@/screens/TodayScreen';
import { articleRepo } from '@/api/repositories';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';
import { parseSelectionScope, useNavigationStore } from '@/store/navigationStore';

export default function ArticleRoute() {
  const desktop = useDesktopLayout();
  const { id, origin: originParam } = useLocalSearchParams<{ id: string; origin?: string }>();
  const routeOrigin = parseSelectionScope(originParam);
  const storedOrigin = useNavigationStore((state) => state.articleOrigins[id] ?? state.articleOrigin);
  const articleFeedSource = useNavigationStore((state) => state.articleFeedSources[id]);
  const origin = routeOrigin ?? storedOrigin;
  const restoreFeedArticle = useNavigationStore((state) => state.restoreFeedArticle);
  const needsFeedContext = origin === 'feeds' && !articleFeedSource;
  const article = useQuery({
    queryKey: ['article', id],
    queryFn: () => articleRepo.get(id),
    enabled: desktop && Boolean(id) && (!origin || needsFeedContext),
  });

  useEffect(() => {
    const item = article.data;
    if (!desktop || !item || (origin && !needsFeedContext)) return;
    restoreFeedArticle(id, {
      kind: 'feed',
      category: item.feedCategory,
      feedId: item.feedId,
      feedRecordId: item.feedRecordId,
      title: item.feedTitle || 'Feed',
    });
  }, [article.data, desktop, id, needsFeedContext, origin, restoreFeedArticle]);

  if (!desktop) return <ArticleDetailScreen />;
  if (origin === 'feeds' || (!origin && article.data)) return <FeedsScreen />;
  if (!origin) return <ArticleDetailScreen />;
  if (origin === 'saved') return <SavedScreen />;
  if (origin === 'category') return <ArticleListScreen />;
  return <TodayScreen />;
}
