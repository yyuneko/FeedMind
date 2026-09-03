import { FlatList, Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { SearchField } from '@/components/SearchField';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArticleRow } from '@/components/ArticleRow';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { ListLoadingIndicator } from '@/components/ListLoadingIndicator';
import { articleRepo } from '@/api/repositories';
import { t } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';
import { DesktopArticleLayout } from '@/components/DesktopArticleLayout';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useRoutedArticleSelection } from '@/hooks/useRoutedArticleSelection';
import { ArticleDetailScreen } from '@/screens/ArticleDetailScreen';
import { articlePageItems, useArticlePages } from '@/hooks/useArticlePages';

export function SavedScreen() {
  const queryClient = useQueryClient();
  const themeColors = useThemeColors();
  const desktop = useDesktopLayout();
  useAppStore((state) => state.languageMode);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const { selectedArticleId, selectArticle } = useRoutedArticleSelection('saved');
  const debouncedQuery = useDebouncedValue(query);
  const articles = useArticlePages({
    queryKey: ['articles', 'starred', debouncedQuery],
    filter: 'starred',
    query: debouncedQuery,
  });
  const data = articlePageItems(articles.data);
  const toggleStar = useMutation({
    mutationFn: (id: string) => articleRepo.setStarred(id, false),
    onSuccess: () => {
      
      queryClient.invalidateQueries({ queryKey: ['articles'] });
    },
  });

  if (!desktop && selectedArticleId) {
    return <ArticleDetailScreen articleId={selectedArticleId} onClose={() => selectArticle(null)} />;
  }

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <View style={[screenStyles.header, desktop && screenStyles.desktopHeader]}>
        {searching && !desktop ? (
          <SearchField
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder={t('search')}
            onEscape={() => { setQuery(''); setSearching(false); }}
          />
        ) : (
          <Text style={[screenStyles.title, { color: themeColors.text }]}>{t('saved')}</Text>
        )}
        {searching && !desktop ? <Pressable style={styles.searchCancel} onPress={() => { setQuery(''); setSearching(false); }}><Text style={{ color: themeColors.blue }}>{t('cancel')}</Text></Pressable> : desktop ? <><IconButton name="refresh-outline" label={t('refresh')} onPress={() => articles.refetch()} /><SearchField value={query} onChangeText={setQuery} placeholder={t('search')} style={styles.desktopSearch} /></> : <IconButton name="search-outline" label={t('search')} onPress={() => setSearching(true)} />}
      </View>
      <DesktopArticleLayout enabled={desktop} selectedArticleId={selectedArticleId} onCloseArticle={() => selectArticle(null)}>
      <View style={screenStyles.flex} onTouchStart={() => searching && Keyboard.dismiss()}>
        {articles.isLoading ? (
          <QueryState title={t('savedLoading')} loading />
        ) : articles.isError ? (
          <QueryState title={t('savedLoadFailed')} message={articles.error instanceof Error ? articles.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={() => articles.refetch()} />
        ) : (
          <>{articles.isFetching && !articles.isFetchingNextPage && data.length > 0 && <ListLoadingIndicator label={t('savedLoading')} />}
          <FlatList
            data={data}
            contentContainerStyle={[screenStyles.content, desktop && screenStyles.desktopContent, data.length === 0 && styles.emptyContent]}
            keyExtractor={(item) => item.id}
            onEndReached={() => { if (articles.hasNextPage && !articles.isFetchingNextPage) void articles.fetchNextPage(); }}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={<QueryState title={t('noSaved')} message={t('noSavedMessage')} actionLabel={t('retry')} onAction={() => articles.refetch()} />}
            ListFooterComponent={articles.isFetchingNextPage ? <ListLoadingIndicator label={t('savedLoading')} footer /> : null}
            renderItem={({ item }) => (
              <ArticleRow compact selected={selectedArticleId === item.id} hidePreviewActions={desktop && Boolean(selectedArticleId)} article={item} onPress={() => selectArticle(item.id)} onToggleStar={() => toggleStar.mutate(item.id)} />
            )}
          /></>
        )}
      </View>
      </DesktopArticleLayout>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  desktopSearch: { width: 280, flex: 0, marginLeft: 16 },
  searchCancel: { marginLeft: 12 },
  emptyContent: { flexGrow: 1, justifyContent: 'center' },
});
