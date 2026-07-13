import { Alert, FlatList, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArticleRow } from '@/components/ArticleRow';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { SegmentedTabs } from '@/components/SegmentedTabs';
import { articleRepo } from '@/api/repositories';
import { t } from '@/i18n';
import { refreshAllFeeds } from '@/services/remoteRss';
import { useAppStore } from '@/store/appStore';
import type { ArticleFilter } from '@/types';
import { colors, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';
import { DesktopArticleLayout } from '@/components/DesktopArticleLayout';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useRoutedArticleSelection } from '@/hooks/useRoutedArticleSelection';
import { ArticleDetailScreen } from '@/screens/ArticleDetailScreen';
import { articlePageItems, articlePageTotal, useArticlePages } from '@/hooks/useArticlePages';

export function TodayScreen() {
  const queryClient = useQueryClient();
  const { filter, setFilter } = useAppStore();
  const themeColors = useThemeColors();
  const desktop = useDesktopLayout();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const { selectedArticleId, selectArticle } = useRoutedArticleSelection('today');
  const debouncedQuery = useDebouncedValue(query);
  const articles = useArticlePages({
    queryKey: ['articles', filter, debouncedQuery],
    filter,
    query: debouncedQuery,
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
      
      queryClient.invalidateQueries({ queryKey: ['articles'] });
    },
  });
  const data = articlePageItems(articles.data);
  const total = articlePageTotal(articles.data);

  if (!desktop && selectedArticleId) {
    return <ArticleDetailScreen articleId={selectedArticleId} onClose={() => selectArticle(null)} />;
  }

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <View style={[screenStyles.header, desktop && screenStyles.desktopHeader]}>
        {searching && !desktop ? (
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder={t('search')}
            placeholderTextColor={themeColors.subtle}
            style={[styles.search, { backgroundColor: themeColors.page, color: themeColors.text }]}
          />
        ) : (
          <Text style={[screenStyles.title, { color: themeColors.text }]}>{t('today')}</Text>
        )}
        {searching && !desktop ? <Pressable style={styles.searchCancel} onPress={() => { setQuery(''); setSearching(false); }}><Text style={{ color: themeColors.blue }}>{t('cancel')}</Text></Pressable> : <IconButton name="refresh-outline" onPress={() => refresh.mutate()} />}
        {desktop ? <><TextInput value={query} onChangeText={setQuery} placeholder={t('search')} placeholderTextColor={themeColors.subtle} style={[styles.desktopSearch, { backgroundColor: themeColors.card, borderColor: themeColors.border, color: themeColors.text }]} />{query ? <Pressable style={styles.searchCancel} onPress={() => setQuery('')}><Text style={{ color: themeColors.blue }}>{t('cancel')}</Text></Pressable> : null}</> : !searching ? <IconButton name="search-outline" onPress={() => setSearching(true)} /> : null}
      </View>
      <DesktopArticleLayout enabled={desktop} selectedArticleId={selectedArticleId} onCloseArticle={() => selectArticle(null)}>
      <View style={screenStyles.flex} onTouchStart={() => searching && Keyboard.dismiss()}>
        <SegmentedTabs<ArticleFilter>
          value={filter}
          onChange={setFilter}
          items={[
            { label: t('all'), value: 'all', count: filter === 'all' ? total : undefined },
            { label: t('unread'), value: 'unread', count: filter === 'unread' ? total : undefined },
            { label: t('starred'), value: 'starred', count: filter === 'starred' ? total : undefined },
          ]}
        />
        {articles.isLoading ? (
          <QueryState title={t('articlesLoading')} />
        ) : articles.isError ? (
          <QueryState title={t('articleLoadFailed')} message={articles.error instanceof Error ? articles.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={() => articles.refetch()} />
        ) : (
          <FlatList
            data={data}
            contentContainerStyle={[screenStyles.content, desktop && screenStyles.desktopContent]}
            keyExtractor={(item) => item.id}
            onEndReached={() => { if (articles.hasNextPage && !articles.isFetchingNextPage) void articles.fetchNextPage(); }}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={<QueryState title={t('noArticles')} message={t('noArticlesMessage')} actionLabel={refresh.isPending ? t('refreshing') : t('refresh')} onAction={() => refresh.mutate()} />}
            renderItem={({ item }) => (
              <ArticleRow
                article={item}
                selected={selectedArticleId === item.id}
                hidePreviewActions={desktop && Boolean(selectedArticleId)}
                onPress={() => selectArticle(item.id)}
                onToggleStar={() => toggleStar.mutate(item.id)}
              />
            )}
          />
        )}
      </View>
      </DesktopArticleLayout>
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
  desktopSearch: { width: 280, height: 40, marginLeft: 16, borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, paddingHorizontal: 14, outlineStyle: 'none' } as any,
  searchCancel: { marginLeft: 12 },
});
