import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { QueryState } from '@/components/QueryState';
import { feedRepo } from '@/db/repositories';
import { t } from '@/i18n';
import { updateFeed } from '@/services/rss';
import { useAppStore } from '@/store/appStore';
import type { Feed } from '@/types';
import { formatEditableFeedCategories, parseFeedCategories, serializeFeedCategories, UNCATEGORIZED_CATEGORY } from '@/utils/categories';
import { colors, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

export function EditFeedScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const themeColors = useThemeColors();
  useAppStore((state) => state.languageMode);
  const feed = useQuery<Feed | null>({ queryKey: ['feed', id], enabled: Boolean(id), queryFn: () => feedRepo.get(id) });
  const feeds = useQuery<Feed[]>({ queryKey: ['feeds'], queryFn: feedRepo.list });
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState('');

  useEffect(() => {
    if (!feed.data) return;
    setTitle(feed.data.title);
    setUrl(feed.data.url);
    setCategory(formatEditableFeedCategories(feed.data.category));
  }, [feed.data]);

  const mutation = useMutation({
    mutationFn: updateFeed,
    onSuccess: () => {
      queryClient.invalidateQueries();
      router.back();
    },
    onError: (error) => Alert.alert(t('updateFailed'), error instanceof Error ? error.message : t('soonRetry')),
  });

  const categoryOptions: string[] = [
    ...Array.from(new Set<string>(
      (feeds.data ?? [])
        .flatMap((item: Feed) => parseFeedCategories(item.category))
        .filter((item: string) => item !== UNCATEGORIZED_CATEGORY),
    )),
  ];
  const toggleCategory = (item: string) => {
    const selected = parseFeedCategories(category)[0];
    const next = selected === item ? '' : item;
    setCategory(formatEditableFeedCategories(serializeFeedCategories(next)));
  };
  const save = () => {
    if (!feed.data || !url.trim()) return;
    mutation.mutate({ id: feed.data.id, title, url, category });
  };

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <View style={screenStyles.header}>
        <Pressable onPress={() => router.back()}>
          <Text style={[screenStyles.link, { color: themeColors.blue }]}>{t('cancel')}</Text>
        </Pressable>
        <Text style={[screenStyles.navTitle, { color: themeColors.text }]}>{t('editFeed')}</Text>
        <Pressable onPress={save}>
          <Text style={[screenStyles.link, { color: themeColors.blue }]}>{mutation.isPending ? t('saving') : t('save')}</Text>
        </Pressable>
      </View>
      {feed.isLoading ? (
        <QueryState title={t('feedLoading')} />
      ) : feed.isError || !feed.data ? (
        <QueryState title={t('feedLoadFailed')} message={feed.error instanceof Error ? feed.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={() => feed.refetch()} />
      ) : (
        <View style={screenStyles.content}>
          <Text style={[styles.label, { color: themeColors.secondary }]}>{t('feedName')}</Text>
          <TextInput value={title} onChangeText={setTitle} placeholder={t('feedName')} placeholderTextColor={themeColors.subtle} style={[styles.input, { borderColor: themeColors.border, color: themeColors.text }]} />
          <Text style={[styles.label, { color: themeColors.secondary }]}>{t('rssUrl')}</Text>
          <TextInput value={url} onChangeText={setUrl} placeholder={t('rssUrl')} placeholderTextColor={themeColors.subtle} autoCapitalize="none" style={[styles.input, { borderColor: themeColors.border, color: themeColors.text }]} />
          <Text style={[styles.label, { color: themeColors.secondary }]}>{t('categories')}</Text>
          <View style={styles.categoryOptions}>
            {categoryOptions.map((item) => {
              const active = parseFeedCategories(category).includes(item);
              return (
                <Pressable key={item} style={[styles.categoryChip, { borderColor: themeColors.border }, active && { backgroundColor: themeColors.pill, borderColor: themeColors.blue }]} onPress={() => toggleCategory(item)}>
                  <Text style={[styles.categoryText, { color: active ? themeColors.blue : themeColors.secondary }]}>{item}</Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput value={category} onChangeText={setCategory} placeholder={t('categoryInputPlaceholder')} placeholderTextColor={themeColors.subtle} style={[styles.input, { borderColor: themeColors.border, color: themeColors.text }]} />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  label: {
    color: colors.secondary,
    fontSize: 12,
    marginTop: 16,
    marginBottom: 7,
  },
  input: {
    height: 42,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: colors.text,
    fontSize: 13,
  },
  categoryOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 2,
  },
  categoryChip: {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    marginBottom: 8,
  },
  categoryChipActive: {
    backgroundColor: colors.pill,
    borderColor: colors.blue,
  },
  categoryText: {
    color: colors.secondary,
    fontSize: 13,
    fontWeight: '600',
  },
  categoryTextActive: {
    color: colors.blue,
  },
});
