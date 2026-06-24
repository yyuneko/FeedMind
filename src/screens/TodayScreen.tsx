import { Alert, FlatList, Keyboard, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArticleRow } from '@/components/ArticleRow';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { SegmentedTabs } from '@/components/SegmentedTabs';
import { articleRepo } from '@/db/repositories';
import { t } from '@/i18n';
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
    onError: (error) => Alert.alert(t('refreshFailed'), error instanceof Error ? error.message : t('soonRetry')),
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
            placeholder={t('search')}
            placeholderTextColor={themeColors.subtle}
            style={[styles.search, { backgroundColor: themeColors.page, color: themeColors.text }]}
            onBlur={() => setSearching(false)}
          />
        ) : (
          <Text style={[screenStyles.title, { color: themeColors.text }]}>{t('today')}</Text>
        )}
        <IconButton name="refresh-outline" onPress={() => refresh.mutate()} />
        <IconButton name="search-outline" onPress={() => setSearching(true)} />
      </View>
      <View style={screenStyles.flex} onTouchStart={() => searching && Keyboard.dismiss()}>
        <SegmentedTabs<ArticleFilter>
          value={filter}
          onChange={setFilter}
          items={[
            { label: t('all'), value: 'all', count: data.length },
            { label: t('unread'), value: 'unread', count: data.filter((item: Article) => !item.isRead).length },
            { label: t('starred'), value: 'starred' },
          ]}
        />
        {articles.isLoading ? (
          <QueryState title={t('articlesLoading')} />
        ) : articles.isError ? (
          <QueryState title={t('articleLoadFailed')} message={articles.error instanceof Error ? articles.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={() => articles.refetch()} />
        ) : (
          <FlatList
            data={data}
            contentContainerStyle={screenStyles.content}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<QueryState title={t('noArticles')} message={t('noArticlesMessage')} actionLabel={refresh.isPending ? t('refreshing') : t('refresh')} onAction={() => refresh.mutate()} />}
            renderItem={({ item }) => (
              <ArticleRow
                article={item}
                onPress={() => router.push(`/article/${item.id}`)}
                onToggleStar={() => toggleStar.mutate(item.id)}
              />
            )}
          />
        )}
      </View>
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
