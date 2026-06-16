import { FlatList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArticleRow } from '@/components/ArticleRow';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { articleRepo } from '@/db/repositories';
import { scheduleSync } from '@/services/sync';
import { screenStyles } from './screenStyles';

export function SavedScreen() {
  const queryClient = useQueryClient();
  const articles = useQuery({ queryKey: ['articles', 'starred'], queryFn: () => articleRepo.list('starred') });
  const toggleStar = useMutation({
    mutationFn: (id: string) => articleRepo.setStarred(id, false),
    onSuccess: () => {
      scheduleSync();
      queryClient.invalidateQueries({ queryKey: ['articles'] });
    },
  });

  return (
    <SafeAreaView style={screenStyles.safe}>
      <View style={screenStyles.header}>
        <Text style={screenStyles.title}>Saved</Text>
        <IconButton name="search-outline" />
      </View>
      {articles.isLoading ? (
        <QueryState title="正在加载收藏" />
      ) : articles.isError ? (
        <QueryState title="收藏加载失败" message={articles.error instanceof Error ? articles.error.message : '请稍后重试'} actionLabel="重试" onAction={() => articles.refetch()} />
      ) : (
        <FlatList
          data={articles.data ?? []}
          contentContainerStyle={screenStyles.content}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={<QueryState title="暂无收藏" message="收藏文章后会显示在这里。" actionLabel="重试" onAction={() => articles.refetch()} />}
          renderItem={({ item }) => (
            <ArticleRow compact article={item} onPress={() => router.push(`/article/${item.id}`)} onToggleStar={() => toggleStar.mutate(item.id)} />
          )}
        />
      )}
    </SafeAreaView>
  );
}
