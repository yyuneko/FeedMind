import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArticleRow } from '@/components/ArticleRow';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { articleRepo, feedRepo } from '@/api/repositories';
import { t } from '@/i18n';
import { refreshFeed } from '@/services/remoteRss';
import { useAppStore } from '@/store/appStore';
import type { Feed } from '@/types';
import { useThemeColors } from '@/utils/theme';
import { confirmDestructiveAction } from '@/utils/confirmAction';
import { screenStyles } from './screenStyles';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';
import { DesktopArticleLayout } from '@/components/DesktopArticleLayout';
import { useRoutedArticleSelection } from '@/hooks/useRoutedArticleSelection';
import { ArticleDetailScreen } from '@/screens/ArticleDetailScreen';
import { useNavigationStore } from '@/store/navigationStore';
import { articlePageItems, useArticlePages } from '@/hooks/useArticlePages';

export function ArticleListScreen() {
	const { category = 'Tech', feedId, sourceFeedId, title } = useLocalSearchParams<{ category: string; feedId?: string; sourceFeedId?: string; title?: string }>();
  const queryClient = useQueryClient();
  const themeColors = useThemeColors();
  const desktop = useDesktopLayout();
  const [menuVisible, setMenuVisible] = useState(false);
  const { selectedArticleId, selectArticle } = useRoutedArticleSelection('feeds');
  const setFeedSource = useNavigationStore((state) => state.setFeedSource);
  useEffect(() => {
    setFeedSource({ kind: sourceFeedId ? 'feed' : 'category', category, feedId: sourceFeedId, feedRecordId: feedId, title: title ?? category });
  }, [category, feedId, sourceFeedId, title, setFeedSource]);
  useAppStore((state) => state.languageMode);
	const articles = useArticlePages({ queryKey: ['articles', 'category', category, sourceFeedId], category: feedId ? undefined : category, feedId: sourceFeedId });
  const unreadArticles = useQuery({
    queryKey: ['articles', 'unread-count', category, sourceFeedId],
    queryFn: () => articleRepo.page('unread', feedId ? undefined : category, sourceFeedId, '', 1, 1),
    select: (page) => page.total,
  });
  const feed = useQuery<Feed | null>({ queryKey: ['feed', feedId], enabled: Boolean(feedId), queryFn: () => feedRepo.get(feedId!) });
  const data = articlePageItems(articles.data);
  const refreshCurrentFeed = useMutation({
    mutationFn: async () => {
      if (!feedId) {
        await articles.refetch();
        return;
      }
      const currentFeed = feed.data ?? (await feedRepo.get(feedId));
      if (!currentFeed) throw new Error(t('rssMissing'));
      await refreshFeed(currentFeed);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['articles'] });
      await queryClient.refetchQueries({ queryKey: ['articles', 'all'], type: 'all' });
    },
    onError: (error) => Alert.alert(t('refreshFailed'), error instanceof Error ? error.message : t('soonRetry')),
  });
  const retryArticles = () => {
    if (feedId) refreshCurrentFeed.mutate();
    else articles.refetch();
  };
  const toggleStar = useMutation({
    mutationFn: async (id: string) => {
      const article = await articleRepo.get(id);
      if (article) await articleRepo.setStarred(id, !article.isStarred);
    },
    onSuccess: () => {
      
      queryClient.invalidateQueries({ queryKey: ['articles'] });
    },
  });
  const removeFeed = useMutation({
    mutationFn: (id: string) => feedRepo.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries();
      router.back();
    },
    onError: (error) => Alert.alert(t('deleteFailed'), error instanceof Error ? error.message : t('soonRetry')),
  });
  const confirmRemoveFeed = (item: Feed) => {
    confirmDestructiveAction({
      title: t('deleteFeed'),
      message: t('deleteFeedConfirm', { title: item.title }),
      cancelText: t('cancel'),
      confirmText: t('delete'),
      onConfirm: () => removeFeed.mutate(item.id),
    });
  };
  const openFeedMenu = () => {
    if (!feed.data) return;
    setMenuVisible((visible) => !visible);
  };
  const closeFeedMenu = () => {
    setMenuVisible(false);
  };
  const runFeedMenuAction = (action: () => void) => {
    setMenuVisible(false);
    action();
  };

  if (!desktop && selectedArticleId) {
    return <ArticleDetailScreen articleId={selectedArticleId} onClose={() => selectArticle(null)} />;
  }

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <View style={[screenStyles.header, desktop && screenStyles.desktopHeader]}>
        <IconButton name="chevron-back" onPress={() => router.back()} />
        <Text style={[screenStyles.navTitle, { color: themeColors.text }]}>{title ?? category}</Text>
        {feedId ? <IconButton name="ellipsis-horizontal" onPress={openFeedMenu} /> : <View style={{ width: 34 }} />}
      </View>
      {menuVisible && feed.data && (
        <>
          <Pressable style={styles.menuBackdrop} onPress={closeFeedMenu} />
          <View style={[styles.dropdownMenu, { backgroundColor: themeColors.card, borderColor: themeColors.border }]}>
            <FeedMenuItem
              icon="create-outline"
              label={t('edit')}
              color={themeColors.text}
              onPress={() => runFeedMenuAction(() => router.push({ pathname: '/feed/edit', params: { id: feed.data!.id } }))}
            />
            <FeedMenuItem
              icon="trash-outline"
              label={t('delete')}
              color="#FF3B30"
              onPress={() => runFeedMenuAction(() => confirmRemoveFeed(feed.data!))}
            />
          </View>
        </>
      )}
      <DesktopArticleLayout enabled={desktop} selectedArticleId={selectedArticleId} onCloseArticle={() => selectArticle(null)}>
      {articles.isLoading ? (
        <QueryState title={t('articlesLoading')} />
      ) : articles.isError ? (
        <QueryState title={t('articleLoadFailed')} message={articles.error instanceof Error ? articles.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={retryArticles} />
      ) : (
        <>
          <View style={[screenStyles.content, desktop && screenStyles.desktopContent]}>
            <Text style={{ color: themeColors.secondary, fontSize: 14, marginBottom: 18 }}>{t('unreadArticles', { count: unreadArticles.data ?? 0 })}</Text>
          </View>
          <FlatList
            data={data}
            contentContainerStyle={[screenStyles.content, desktop && screenStyles.desktopContent]}
            keyExtractor={(item) => item.id}
            onEndReached={() => { if (articles.hasNextPage && !articles.isFetchingNextPage) void articles.fetchNextPage(); }}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={<QueryState title={t('noArticles')} message={t('noArticlesInCategory')} actionLabel={feedId ? (refreshCurrentFeed.isPending ? t('refreshing') : t('refresh')) : t('retry')} onAction={retryArticles} />}
            renderItem={({ item }) => (
              <ArticleRow selected={selectedArticleId === item.id} hidePreviewActions={desktop && Boolean(selectedArticleId)} hideFeedName={Boolean(feedId)} article={item} onPress={() => selectArticle(item.id)} onToggleStar={() => toggleStar.mutate(item.id)} />
            )}
          />
        </>
      )}
      </DesktopArticleLayout>
    </SafeAreaView>
  );
}
const FeedMenuItem = ({ icon, label, color, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; color: string; onPress: () => void }) => (
  <Pressable style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]} onPress={onPress}>
    <Ionicons name={icon} size={18} color={color} />
    <Text style={[styles.menuItemText, { color }]}>{label}</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  menuBackdrop: {
    position: 'absolute',
    top: 62,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 10,
  },
  dropdownMenu: {
    position: 'absolute',
    top: 54,
    right: 16,
    minWidth: 136,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 6,
    zIndex: 11,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 8,
  },
  menuItem: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  menuItemText: {
    marginLeft: 10,
    fontSize: 14,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.55,
  },
});


