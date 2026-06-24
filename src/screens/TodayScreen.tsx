import { Alert, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArticleRow } from '@/components/ArticleRow';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { SegmentedTabs } from '@/components/SegmentedTabs';
import { articleRepo } from '@/db/repositories';
import { refreshAllFeeds } from '@/services/rss';
import { scheduleSync } from '@/services/sync';
import { useAppStore } from '@/store/appStore';
import type { Article, ArticleFilter } from '@/types';
import { colors, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

export function TodayScreen() {
  const queryClient = useQueryClient();
  const { filter, setFilter } = useAppStore();
  const themeColors = useThemeColors();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const articles = useQuery<Article[]>({
    queryKey: ['articles', filter, query],
    queryFn: () => (query ? articleRepo.search(query) : articleRepo.list(filter)),
  });
  const refresh = useMutation({
    mutationFn: refreshAllFeeds,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['articles'] }),
    onError: (error) => Alert.alert('刷新失败', error instanceof Error ? error.message : '请稍后重试'),
  });
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
  const data = articles.data ?? [];

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <View style={screenStyles.header}>
        {searching ? (
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={themeColors.subtle}
            style={[styles.search, { backgroundColor: themeColors.page, color: themeColors.text }]}
            onBlur={() => !query && setSearching(false)}
          />
        ) : (
          <Text style={[screenStyles.title, { color: themeColors.text }]}>Today</Text>
        )}
        <IconButton name="checkmark-circle-outline" onPress={() => refresh.mutate()} />
        <IconButton name="search-outline" onPress={() => setSearching(true)} />
      </View>
      <SegmentedTabs<ArticleFilter>
        value={filter}
        onChange={setFilter}
        items={[
          { label: 'All', value: 'all', count: data.length },
          { label: 'Unread', value: 'unread', count: data.filter((item: Article) => !item.isRead).length },
          { label: 'Starred', value: 'starred' },
        ]}
      />
      {articles.isLoading ? (
        <QueryState title="正在加载文章" />
      ) : articles.isError ? (
        <QueryState title="文章加载失败" message={articles.error instanceof Error ? articles.error.message : '请稍后重试'} actionLabel="重试" onAction={() => articles.refetch()} />
      ) : (
        <FlatList
          data={data}
          contentContainerStyle={screenStyles.content}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={<QueryState title="暂无文章" message="可以先添加 RSS 源，或刷新现有订阅。" actionLabel={refresh.isPending ? '刷新中' : '刷新'} onAction={() => refresh.mutate()} />}
          renderItem={({ item }) => (
            <ArticleRow
              article={item}
              onPress={() => router.push(`/article/${item.id}`)}
              onToggleStar={() => toggleStar.mutate(item.id)}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  search: {
    flex: 1,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.page,
    paddingHorizontal: 14,
    fontSize: 17,
  },
});
