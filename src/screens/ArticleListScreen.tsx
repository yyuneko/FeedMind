import { Alert, FlatList, View, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArticleRow } from '@/components/ArticleRow';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { articleRepo, feedRepo } from '@/db/repositories';
import { scheduleSync } from '@/services/sync';
import type { Article, Feed } from '@/types';
import { colors, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

export function ArticleListScreen() {
  const { category = 'Tech', feedId, title } = useLocalSearchParams<{ category: string; feedId?: string; title?: string }>();
  const queryClient = useQueryClient();
  const themeColors = useThemeColors();
  const articles = useQuery<Article[]>({ queryKey: ['articles', 'category', category, feedId], queryFn: () => articleRepo.list('all', feedId ? undefined : category, feedId) });
  const feed = useQuery<Feed | null>({ queryKey: ['feed', feedId], enabled: Boolean(feedId), queryFn: () => feedRepo.get(feedId!) });
  const data = articles.data ?? [];
  const toggleStar = useMutation({
    mutationFn: async (id: string) => {
      const article = await articleRepo.get(id);
      if (article) await articleRepo.setStarred(id, !article.isStarred);
    },
    onSuccess: () => {
      scheduleSync();
      queryClient.invalidateQueries({ queryKey: ['articles'] });
    },
  });
  const removeFeed = useMutation({
    mutationFn: (id: string) => feedRepo.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries();
      router.back();
    },
    onError: (error) => Alert.alert('删除失败', error instanceof Error ? error.message : '请稍后重试'),
  });
  const confirmRemoveFeed = (item: Feed) => {
    Alert.alert('删除订阅源', `确定删除「${item.title}」及其文章吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => removeFeed.mutate(item.id) },
    ]);
  };
  const openFeedMenu = () => {
    if (!feed.data) return;
    Alert.alert(feed.data.title, feed.data.url, [
      { text: '取消', style: 'cancel' },
      { text: '编辑', onPress: () => router.push({ pathname: '/feed/edit', params: { id: feed.data!.id } }) },
      { text: '删除', style: 'destructive', onPress: () => confirmRemoveFeed(feed.data!) },
    ]);
  };

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <View style={screenStyles.header}>
        <IconButton name="chevron-back" onPress={() => router.back()} />
        <Text style={[screenStyles.navTitle, { color: themeColors.text }]}>{title ?? category}</Text>
        {feedId ? <IconButton name="ellipsis-horizontal" onPress={openFeedMenu} /> : <View style={{ width: 34 }} />}
      </View>
      {articles.isLoading ? (
        <QueryState title="正在加载文章" />
      ) : articles.isError ? (
        <QueryState title="文章加载失败" message={articles.error instanceof Error ? articles.error.message : '请稍后重试'} actionLabel="重试" onAction={() => articles.refetch()} />
      ) : (
        <>
          <View style={screenStyles.content}>
            <Text style={{ color: themeColors.secondary, fontSize: 14, marginBottom: 18 }}>{data.filter((item: Article) => !item.isRead).length} unread articles</Text>
          </View>
          <FlatList
            data={data}
            contentContainerStyle={screenStyles.content}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<QueryState title="暂无文章" message="该分类下还没有文章。" actionLabel="重试" onAction={() => articles.refetch()} />}
            renderItem={({ item }) => (
              <ArticleRow article={item} onPress={() => router.push(`/article/${item.id}`)} onToggleStar={() => toggleStar.mutate(item.id)} />
            )}
          />
        </>
      )}
    </SafeAreaView>
  );
}
