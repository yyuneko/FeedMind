import { FlatList, Keyboard, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArticleRow } from '@/components/ArticleRow';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { articleRepo } from '@/db/repositories';
import { t } from '@/i18n';
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
            placeholder={t('search')}
            placeholderTextColor={themeColors.subtle}
            style={[styles.search, { backgroundColor: themeColors.page, color: themeColors.text }]}
            onBlur={() => setSearching(false)}
          />
        ) : (
          <Text style={[screenStyles.title, { color: themeColors.text }]}>{t('saved')}</Text>
        )}
        <IconButton name="search-outline" onPress={() => setSearching(true)} />
      </View>
      <View style={screenStyles.flex} onTouchStart={() => searching && Keyboard.dismiss()}>
        {articles.isLoading ? (
          <QueryState title={t('savedLoading')} />
        ) : articles.isError ? (
          <QueryState title={t('savedLoadFailed')} message={articles.error instanceof Error ? articles.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={() => articles.refetch()} />
        ) : (
          <FlatList
            data={articles.data ?? []}
            contentContainerStyle={screenStyles.content}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<QueryState title={t('noSaved')} message={t('noSavedMessage')} actionLabel={t('retry')} onAction={() => articles.refetch()} />}
            renderItem={({ item }) => (
              <ArticleRow compact article={item} onPress={() => router.push(`/article/${item.id}`)} onToggleStar={() => toggleStar.mutate(item.id)} />
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
