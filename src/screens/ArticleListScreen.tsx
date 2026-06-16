import { FlatList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArticleRow } from '@/components/ArticleRow';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { articleRepo } from '@/db/repositories';
import { scheduleSync } from '@/services/sync';
import type { Article } from '@/types';
import { colors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

export function ArticleListScreen() {
  const { category = 'Tech', feedId, title } = useLocalSearchParams<{ category: string; feedId?: string; title?: string }>();
  const queryClient = useQueryClient();
  const articles = useQuery<Article[]>({ queryKey: ['articles', 'category', category, feedId], queryFn: () => articleRepo.list('all', feedId ? undefined : category, feedId) });
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

  return (
    <SafeAreaView style={screenStyles.safe}>
      <View style={screenStyles.header}>
        <IconButton name="chevron-back" onPress={() => router.back()} />
        <Text style={screenStyles.navTitle}>{title ?? category}</Text>
        <IconButton name="ellipsis-horizontal" />
      </View>
      {articles.isLoading ? (
        <QueryState title="正在加载文章" />
      ) : articles.isError ? (
        <QueryState title="文章加载失败" message={articles.error instanceof Error ? articles.error.message : '请稍后重试'} actionLabel="重试" onAction={() => articles.refetch()} />
      ) : (
        <>
          <View style={screenStyles.content}>
            <Text style={{ color: colors.secondary, fontSize: 14, marginBottom: 18 }}>{data.filter((item: Article) => !item.isRead).length} unread articles</Text>
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
