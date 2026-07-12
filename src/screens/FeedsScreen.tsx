import { Alert, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FeedRow } from '@/components/FeedRow';
import { IconButton } from '@/components/IconButton';
import { articleRepo, feedRepo } from '@/db/repositories';
import { t } from '@/i18n';
import { addFeed, importFeedsFromOpmlUrl, isOpmlUrl, type OpmlImportProgress } from '@/services/rss';
import { useAppStore } from '@/store/appStore';
import type { Article, Feed } from '@/types';
import { formatEditableFeedCategories, parseFeedCategories, serializeFeedCategories, UNCATEGORIZED_CATEGORY } from '@/utils/categories';
import { getFeedIconUrl } from '@/utils/html';
import { colors, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

const categoryColors = ['#6B6FDD', '#8B5CF6', '#0EA5A3', '#EAB308', '#EF4444'];

type ImportProgressState = OpmlImportProgress | null;

export function FeedsScreen() {
  const queryClient = useQueryClient();
  const themeColors = useThemeColors();
  useAppStore((state) => state.languageMode);
  const [addVisible, setAddVisible] = useState(false);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState('');
  const [importProgress, setImportProgress] = useState<ImportProgressState>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const feeds = useQuery<Feed[]>({ queryKey: ['feeds'], queryFn: feedRepo.list });
  const articles = useQuery<Article[]>({ queryKey: ['articles', 'all'], queryFn: () => articleRepo.list('all') });
  const mutation = useMutation({
    mutationFn: async (feed: { title: string; url: string; category: string }) => {
      if (isOpmlUrl(feed.url)) {
        setImportProgress({ total: 0, done: 0, imported: 0, failed: 0 });
        return { kind: 'opml' as const, ...(await importFeedsFromOpmlUrl(feed.url, feed.category, setImportProgress)) };
      }
      setImportProgress(null);
      return { kind: 'feed' as const, feed: await addFeed({ title: feed.title, url: feed.url }, feed.category) };
    },
    onSuccess: (result) => {
      setTitle('');
      setUrl('');
      setCategory('');
      setImportProgress(null);
      setAddVisible(false);
      queryClient.invalidateQueries();
      if (result.kind === 'opml') {
        Alert.alert(t('opmlImportDone'), t('opmlImportSummary', { imported: result.imported, failed: result.failed }));
      }
    },
    onError: (error) => {
      setImportProgress(null);
      Alert.alert(t('addFailed'), error instanceof Error ? error.message : t('checkRssUrl'));
    },
  });
  const removeFeed = useMutation({
    mutationFn: (id: string) => feedRepo.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
    onError: (error) => Alert.alert(t('deleteFailed'), error instanceof Error ? error.message : t('soonRetry')),
  });
  const allFeeds: Feed[] = feeds.data ?? [];
  const allArticles = articles.data ?? [];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleFeeds = normalizedQuery
    ? allFeeds.filter((feed) => `${feed.title} ${feed.url} ${feed.category}`.toLowerCase().includes(normalizedQuery))
    : allFeeds;
  const categoryMap = new Map<string, number>();
  for (const feed of allFeeds) {
    const count = allArticles.filter((item: Article) => item.feedId === feed.id).length;
    for (const item of parseFeedCategories(feed.category)) {
      categoryMap.set(item, count + (categoryMap.get(item) ?? 0));
    }
  }
  const allCategories = [...categoryMap.entries()];
  const categories = allCategories.filter(([item]) => !normalizedQuery || item.toLowerCase().includes(normalizedQuery));
  const categoryOptions = allCategories.map(([item]) => item).filter((item) => item !== UNCATEGORIZED_CATEGORY);
  const isImportingOpml = mutation.isPending && isOpmlUrl(url);
  const progressRatio = importProgress?.total ? importProgress.done / importProgress.total : 0;
  const progressPercent = `${Math.min(100, Math.round(progressRatio * 100))}%` as `${number}%`;
  const toggleCategory = (value: string, item: string) => {
    const selected = parseFeedCategories(value)[0];
    const next = selected === item ? '' : item;
    return formatEditableFeedCategories(serializeFeedCategories(next));
  };
  const confirmRemoveFeed = (feed: Feed) => {
    Alert.alert(t('deleteFeed'), t('deleteFeedConfirm', { title: feed.title }), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('delete'), style: 'destructive', onPress: () => removeFeed.mutate(feed.id) },
    ]);
  };
  const openEditFeed = (feed: Feed) => {
    router.push({ pathname: '/feed/edit', params: { id: feed.id } });
  };
  const openFeedActions = (feed: Feed) => {
    Alert.alert(feed.title, feed.url, [
      { text: t('cancel'), style: 'cancel' },
      { text: t('edit'), onPress: () => openEditFeed(feed) },
      { text: t('delete'), style: 'destructive', onPress: () => confirmRemoveFeed(feed) },
    ]);
  };

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
          <Text style={[screenStyles.title, { color: themeColors.text }]}>{t('feeds')}</Text>
        )}
        <IconButton name="search-outline" onPress={() => setSearching(true)} />
      </View>
      <ScrollView
        style={screenStyles.flex}
        contentContainerStyle={screenStyles.content}
        keyboardShouldPersistTaps="handled"
        onTouchStart={() => searching && Keyboard.dismiss()}
      >
        <FeedRow title={t('allArticles')} count={allArticles.length} icon="reader-outline" color={themeColors.text} onPress={() => router.push('/')} />
        <Text style={[screenStyles.sectionTitle, { color: themeColors.text }]}>{t('categories')}</Text>
        {categories.map(([categoryName, count], index) => (
          <FeedRow
            key={categoryName}
            title={categoryName === UNCATEGORIZED_CATEGORY ? t('uncategorized') : categoryName}
            count={count}
            icon="folder-outline"
            color={categoryName === UNCATEGORIZED_CATEGORY ? '#5B6472' : categoryColors[index % categoryColors.length]}
            onPress={() => router.push({ pathname: '/article/category', params: { category: categoryName } })}
          />
        ))}
        <Text style={[screenStyles.sectionTitle, { color: themeColors.text }]}>{t('myFeeds')}</Text>
        {visibleFeeds.map((item, index) => (
          <FeedRow
            key={item.id}
            title={item.title}
            count={allArticles.filter((article: Article) => article.feedId === item.id).length}
            imageUrl={getFeedIconUrl(item.siteUrl, item.url)}
            color={categoryColors[index % categoryColors.length]}
            onPress={() => router.push({ pathname: '/article/category', params: { category: parseFeedCategories(item.category)[0], feedId: item.id, title: item.title } })}
            onLongPress={() => openFeedActions(item)}
            onEdit={() => openEditFeed(item)}
            onDelete={() => confirmRemoveFeed(item)}
          />
        ))}
        <View style={styles.addBox}>
          <Pressable style={styles.addButton} onPress={() => {
            setImportProgress(null);
            setAddVisible(true);
          }}>
            <Text style={[screenStyles.link, { color: themeColors.blue }]}>＋ {t('addFeed')}</Text>
          </Pressable>
        </View>
      </ScrollView>
      <Modal visible={addVisible} transparent animationType="fade" onRequestClose={() => setAddVisible(false)}>
        <View style={styles.modalMask}>
          <View style={[styles.modal, { backgroundColor: themeColors.card }]}>
            <Text style={[styles.modalTitle, { color: themeColors.text }]}>{t('addFeed')}</Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              editable={!mutation.isPending}
              placeholder={t('feedName')}
              placeholderTextColor={themeColors.subtle}
              style={[styles.input, { borderColor: themeColors.border, color: themeColors.text }]}
            />
            <TextInput
              value={url}
              onChangeText={setUrl}
              editable={!mutation.isPending}
              placeholder={t('rssOrOpmlUrl')}
              autoCapitalize="none"
              placeholderTextColor={themeColors.subtle}
              style={[styles.input, styles.editUrlInput, { borderColor: themeColors.border, color: themeColors.text }]}
            />
            <Text style={[styles.fieldLabel, { color: themeColors.secondary }]}>{t('categories')}</Text>
            <View style={styles.categoryOptions}>
              {categoryOptions.map((item) => {
                const active = parseFeedCategories(category).includes(item);
                return (
                  <Pressable key={item} style={[styles.categoryChip, { borderColor: themeColors.border }, active && { backgroundColor: themeColors.pill, borderColor: themeColors.blue }]} onPress={() => setCategory(toggleCategory(category, item))}>
                    <Text style={[styles.categoryText, { color: active ? themeColors.blue : themeColors.secondary }]}>{item}</Text>
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              value={category}
              onChangeText={setCategory}
              editable={!mutation.isPending}
              placeholder={t('categoryInputPlaceholder')}
              placeholderTextColor={themeColors.subtle}
              style={[styles.input, styles.categoryInput, { borderColor: themeColors.border, color: themeColors.text }]}
            />
            {isImportingOpml && importProgress ? (
              <View style={styles.progressBox}>
                <View style={styles.progressHeader}>
                  <Text style={[styles.progressText, { color: themeColors.secondary }]}>{t('opmlImportProgress', { done: importProgress.done, total: importProgress.total })}</Text>
                  <Text style={[styles.progressText, { color: themeColors.secondary }]}>{t('opmlImportCounts', { imported: importProgress.imported, failed: importProgress.failed })}</Text>
                </View>
                <View style={[styles.progressTrack, { backgroundColor: themeColors.page }]}>
                  <View style={[styles.progressFill, { width: progressPercent, backgroundColor: themeColors.blue }]} />
                </View>
                {importProgress.currentTitle ? <Text numberOfLines={1} style={[styles.progressCurrent, { color: themeColors.subtle }]}>{t('opmlImportCurrent', { title: importProgress.currentTitle })}</Text> : null}
              </View>
            ) : null}
            <View style={styles.modalActions}>
              <Pressable style={styles.modalButton} disabled={mutation.isPending} onPress={() => setAddVisible(false)}>
                <Text style={[styles.cancelText, { color: mutation.isPending ? themeColors.subtle : themeColors.secondary }]}>{t('cancel')}</Text>
              </Pressable>
              <Pressable style={[styles.modalButton, mutation.isPending && styles.disabledButton]} disabled={mutation.isPending} onPress={() => url.trim() && mutation.mutate({ title, url, category })}>
                <Text style={[screenStyles.link, { color: themeColors.blue }]}>{mutation.isPending ? (isOpmlUrl(url) ? t('importing') : t('adding')) : t('add')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  addBox: {
    marginTop: 28,
  },
  search: {
    flex: 1,
    height: 40,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 17,
  },
  input: {
    height: 42,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  editUrlInput: {
    marginTop: 10,
  },
  categoryInput: {
    marginTop: 2,
  },
  fieldLabel: {
    marginTop: 16,
    marginBottom: 10,
    color: colors.secondary,
    fontSize: 13,
    fontWeight: '600',
  },
  categoryOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
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
  addButton: {
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalMask: {
    flex: 1,
    paddingHorizontal: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.28)',
    justifyContent: 'center',
  },
  modal: {
    borderRadius: 12,
    backgroundColor: colors.card,
    padding: 18,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
  progressBox: {
    marginTop: 14,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  progressText: {
    fontSize: 12,
    fontWeight: '600',
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: 6,
    borderRadius: 3,
  },
  progressCurrent: {
    marginTop: 8,
    fontSize: 12,
  },
  disabledButton: {
    opacity: 0.55,
  },
  modalActions: {
    height: 48,
    marginTop: 12,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  modalButton: {
    minWidth: 72,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    color: colors.secondary,
    fontSize: 15,
    fontWeight: '600',
  },
});
