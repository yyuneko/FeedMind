import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArticleRow } from '@/components/ArticleRow';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { articleRepo } from '@/db/repositories';
import { scheduleSync } from '@/services/sync';
import { colors, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

export function SavedScreen() {
  const queryClient = useQueryClient();
  const themeColors = useThemeColors();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const articles = useQuery({
    queryKey: ['articles', 'starred', query],
    queryFn: async () => {
      if (!query.trim()) return articleRepo.list('starred');
      const items = await articleRepo.search(query);
      return items.filter((item) => item.isStarred);
    },
  });
  const toggleStar = useMutation({
    mutationFn: (id: string) => articleRepo.setStarred(id, false),
    onSuccess: () => {
      scheduleSync();
      queryClient.invalidateQueries({ queryKey: ['articles'] });
    },
  });

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
          <Text style={[screenStyles.title, { color: themeColors.text }]}>Saved</Text>
        )}
        <IconButton name="search-outline" onPress={() => setSearching(true)} />
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
