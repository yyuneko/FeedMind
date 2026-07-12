import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
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
import type { Article, Feed } from '@/types';
import { useThemeColors } from '@/utils/theme';
import { confirmDestructiveAction } from '@/utils/confirmAction';
import { screenStyles } from './screenStyles';

export function ArticleListScreen() {
	const { category = 'Tech', feedId, sourceFeedId, title } = useLocalSearchParams<{ category: string; feedId?: string; sourceFeedId?: string; title?: string }>();
  const queryClient = useQueryClient();
  const themeColors = useThemeColors();
  const [menuVisible, setMenuVisible] = useState(false);
  useAppStore((state) => state.languageMode);
	const articles = useQuery<Article[]>({ queryKey: ['articles', 'category', category, sourceFeedId], queryFn: () => articleRepo.list('all', feedId ? undefined : category, sourceFeedId) });
  const feed = useQuery<Feed | null>({ queryKey: ['feed', feedId], enabled: Boolean(feedId), queryFn: () => feedRepo.get(feedId!) });
  const data = articles.data ?? [];
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

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <View style={screenStyles.header}>
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
      {articles.isLoading ? (
        <QueryState title={t('articlesLoading')} />
      ) : articles.isError ? (
        <QueryState title={t('articleLoadFailed')} message={articles.error instanceof Error ? articles.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={retryArticles} />
      ) : (
        <>
          <View style={screenStyles.content}>
            <Text style={{ color: themeColors.secondary, fontSize: 14, marginBottom: 18 }}>{t('unreadArticles', { count: data.filter((item: Article) => !item.isRead).length })}</Text>
          </View>
          <FlatList
            data={data}
            contentContainerStyle={screenStyles.content}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<QueryState title={t('noArticles')} message={t('noArticlesInCategory')} actionLabel={feedId ? (refreshCurrentFeed.isPending ? t('refreshing') : t('refresh')) : t('retry')} onAction={retryArticles} />}
            renderItem={({ item }) => (
              <ArticleRow article={item} onPress={() => router.push(`/article/${item.id}`)} onToggleStar={() => toggleStar.mutate(item.id)} />
            )}
          />
        </>
      )}
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


