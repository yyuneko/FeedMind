import { FlatList, Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { AutofillSafeTextInput as TextInput } from '@/components/AutofillSafeTextInput';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArticleRow } from '@/components/ArticleRow';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { articleRepo } from '@/api/repositories';
import { t } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { colors, useThemeColors } from '@/utils/theme';
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
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder={t('search')}
            placeholderTextColor={themeColors.subtle}
            style={[styles.search, { backgroundColor: themeColors.page, color: themeColors.text }]}
          />
        ) : (
          <Text style={[screenStyles.title, { color: themeColors.text }]}>{t('saved')}</Text>
        )}
        {searching && !desktop ? <Pressable style={styles.searchCancel} onPress={() => { setQuery(''); setSearching(false); }}><Text style={{ color: themeColors.blue }}>{t('cancel')}</Text></Pressable> : desktop ? <><IconButton name="refresh-outline" onPress={() => articles.refetch()} /><TextInput value={query} onChangeText={setQuery} placeholder={t('search')} placeholderTextColor={themeColors.subtle} style={[styles.desktopSearch, { backgroundColor: themeColors.card, borderColor: themeColors.border, color: themeColors.text }]} />{query ? <Pressable style={styles.searchCancel} onPress={() => setQuery('')}><Text style={{ color: themeColors.blue }}>{t('cancel')}</Text></Pressable> : null}</> : <IconButton name="search-outline" onPress={() => setSearching(true)} />}
      </View>
      <DesktopArticleLayout enabled={desktop} selectedArticleId={selectedArticleId} onCloseArticle={() => selectArticle(null)}>
      <View style={screenStyles.flex} onTouchStart={() => searching && Keyboard.dismiss()}>
        {articles.isLoading ? (
          <QueryState title={t('savedLoading')} />
        ) : articles.isError ? (
          <QueryState title={t('savedLoadFailed')} message={articles.error instanceof Error ? articles.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={() => articles.refetch()} />
        ) : (
          <FlatList
            data={data}
            contentContainerStyle={[screenStyles.content, desktop && screenStyles.desktopContent, data.length === 0 && styles.emptyContent]}
            keyExtractor={(item) => item.id}
            onEndReached={() => { if (articles.hasNextPage && !articles.isFetchingNextPage) void articles.fetchNextPage(); }}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={<QueryState title={t('noSaved')} message={t('noSavedMessage')} actionLabel={t('retry')} onAction={() => articles.refetch()} />}
            renderItem={({ item }) => (
              <ArticleRow compact selected={selectedArticleId === item.id} hidePreviewActions={desktop && Boolean(selectedArticleId)} article={item} onPress={() => selectArticle(item.id)} onToggleStar={() => toggleStar.mutate(item.id)} />
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
  emptyContent: { flexGrow: 1, justifyContent: 'center' },
});
