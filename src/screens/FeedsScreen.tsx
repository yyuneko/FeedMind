import { Alert, FlatList, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams, usePathname } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { FeedRow } from '@/components/FeedRow';
import { ArticleRow } from '@/components/ArticleRow';
import { DesktopArticleLayout } from '@/components/DesktopArticleLayout';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { articleRepo, feedRepo } from '@/api/repositories';
import { t } from '@/i18n';
import { addFeed, importFeedsFromOpmlUrl, isOpmlUrl, refreshFeedTitle, type OpmlImportProgress } from '@/services/remoteRss';
import { useAppStore } from '@/store/appStore';
import type { Article, Feed } from '@/types';
import { formatEditableFeedCategories, parseFeedCategories, serializeFeedCategories, UNCATEGORIZED_CATEGORY } from '@/utils/categories';
import { getFeedIconUrl } from '@/utils/html';
import { confirmDestructiveAction } from '@/utils/confirmAction';
import { colors, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { type FeedSourceSelection, useNavigationStore } from '@/store/navigationStore';
import { useRoutedArticleSelection } from '@/hooks/useRoutedArticleSelection';
import { articlePageItems, articlePageTotal, useArticlePages } from '@/hooks/useArticlePages';

const categoryColors = ['#6B6FDD', '#8B5CF6', '#0EA5A3', '#EAB308', '#EF4444'];

type ImportProgressState = OpmlImportProgress | null;
const getFeedArticleCount = (feed: Feed, articles: Article[]) => {
  const count = Number(feed.articleCount);
  return Number.isFinite(count)
    ? count
    : articles.filter((article) => article.feedId === feed.feedId).length;
};

const isWaitingForInitialArticles = (feed: Feed) => {
  const isFetching = feed.fetchStatus === 'pending' || feed.fetchStatus === 'fetching';
  const articleCount = Number(feed.articleCount);
  return isFetching && (!Number.isFinite(articleCount) || articleCount === 0);
};

export function FeedsScreen() {
  const queryClient = useQueryClient();
  const themeColors = useThemeColors();
  const desktop = useDesktopLayout();
  const pathname = usePathname();
  const routeParams = useLocalSearchParams<{ id?: string; category?: string; feedId?: string; sourceFeedId?: string; title?: string }>();
  const storedSource = useNavigationStore((state) => state.feedSource);
  const articleSource = useNavigationStore((state) => routeParams.id ? state.articleFeedSources[routeParams.id] : undefined);
  const routeSource: FeedSourceSelection | null = pathname === '/article/category' ? {
    kind: routeParams.sourceFeedId ? 'feed' : 'category',
    category: routeParams.category,
    feedId: routeParams.sourceFeedId,
    feedRecordId: routeParams.feedId,
    title: routeParams.title ?? routeParams.category ?? '',
  } : null;
  const desktopSource = routeSource ?? (pathname.startsWith('/article/') ? articleSource ?? storedSource : null);
  const { selectedArticleId, selectArticle } = useRoutedArticleSelection('feeds');
  const setDesktopSource = useNavigationStore((state) => state.setFeedSource);
  useAppStore((state) => state.languageMode);
  const [addVisible, setAddVisible] = useState(false);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState('');
  const [importProgress, setImportProgress] = useState<ImportProgressState>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query);
  useEffect(() => {
    if (routeSource) setDesktopSource(routeSource);
    else if (pathname === '/feeds') setDesktopSource(null);
  }, [pathname, routeParams.category, routeParams.feedId, routeParams.sourceFeedId, routeParams.title, setDesktopSource]);
  const selectDesktopSource = (source: Omit<FeedSourceSelection, 'kind'>, kind: FeedSourceSelection['kind']) => {
    setDesktopSource({ ...source, kind });
    const target = kind === 'all'
      ? '/'
      : { pathname: '/article/category' as const, params: { category: source.category, feedId: source.feedRecordId, sourceFeedId: source.feedId, title: source.title } };
    if (desktopSource?.kind === kind) router.replace(target);
    else router.push(target);
  };
  const clearDesktopSource = () => {
    setDesktopSource(null);
    router.push('/feeds');
  };
  const feeds = useQuery<Feed[]>({
    queryKey: ['feeds', debouncedQuery],
    queryFn: async () => (await feedRepo.page(1, debouncedQuery, 100)).items,
    refetchInterval: (query) => query.state.data?.some(isWaitingForInitialArticles) ? 1000 : false,
  });
  const articles = useArticlePages({ queryKey: ['articles', 'all'] });
  const sourceArticles = useArticlePages({
    queryKey: ['articles', 'desktop-source', desktopSource?.category, desktopSource?.feedId],
    enabled: Boolean(desktopSource),
    category: desktopSource?.feedId ? undefined : desktopSource?.category,
    feedId: desktopSource?.feedId,
  });
  const toggleArticleStar = useMutation({
    mutationFn: async (id: string) => {
      const article = await articleRepo.get(id);
      if (article) await articleRepo.setStarred(id, !article.isStarred);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['articles'] }),
  });
  useFocusEffect(
    useCallback(() => {
      void queryClient.invalidateQueries({ queryKey: ['feeds'] });
    }, [queryClient]),
  );
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
  const refreshNames = useMutation({
    mutationFn: async (items: Feed[]) => {
      let success = 0;
      let failed = 0;
      await Promise.all(items.map(async (item) => {
        try {
          await refreshFeedTitle(item);
          success += 1;
        } catch {
          failed += 1;
        }
      }));
      return { success, failed };
    },
    onSuccess: ({ success, failed }) => {
      queryClient.invalidateQueries({ queryKey: ['feeds'] });
      Alert.alert(t('feedNameBatchUpdateDone', { success, failed }));
    },
  });
  const allFeeds: Feed[] = feeds.data ?? [];
  const allArticles = articlePageItems(articles.data);
  const allArticleCount = articlePageTotal(articles.data);
  const sourceArticleItems = articlePageItems(sourceArticles.data);
  const normalizedQuery = debouncedQuery.trim().toLowerCase();
  const visibleFeeds = allFeeds;
  const categoryMap = new Map<string, number>();
  for (const feed of allFeeds) {
    const articleCount = getFeedArticleCount(feed, allArticles);
    for (const item of parseFeedCategories(feed.category)) {
      categoryMap.set(item, articleCount + (categoryMap.get(item) ?? 0));
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
    confirmDestructiveAction({
      title: t('deleteFeed'),
      message: t('deleteFeedConfirm', { title: feed.title }),
      cancelText: t('cancel'),
      confirmText: t('delete'),
      onConfirm: () => removeFeed.mutate(feed.id),
    });
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
          <Text style={[screenStyles.title, { color: themeColors.text }]}>{t('feeds')}</Text>
        )}
        {searching && !desktop ? <Pressable style={styles.searchCancel} onPress={() => { setQuery(''); setSearching(false); }}><Text style={{ color: themeColors.blue }}>{t('cancel')}</Text></Pressable> : desktop ? <><TextInput value={query} onChangeText={setQuery} placeholder={t('search')} placeholderTextColor={themeColors.subtle} style={[styles.desktopSearch, { backgroundColor: themeColors.card, borderColor: themeColors.border, color: themeColors.text }]} />{query ? <Pressable style={styles.searchCancel} onPress={() => setQuery('')}><Text style={{ color: themeColors.blue }}>{t('cancel')}</Text></Pressable> : null}<Pressable style={[styles.desktopAdd, { backgroundColor: themeColors.blue }]} onPress={() => setAddVisible(true)}><Ionicons name="add" size={18} color="#fff" /><Text style={styles.desktopAddText}>{t('addFeed')}</Text></Pressable></> : <IconButton name="search-outline" onPress={() => setSearching(true)} />}
      </View>
      <View style={desktop ? styles.desktopWorkspace : screenStyles.flex}>
        {(!desktop || !selectedArticleId || !desktopSource) && <ScrollView
          style={desktop && desktopSource ? styles.desktopSources : screenStyles.flex}
          contentContainerStyle={[screenStyles.content, styles.scrollContent, desktop && screenStyles.desktopContent, desktop && styles.desktopColumns]}
          keyboardShouldPersistTaps="handled"
          onTouchStart={() => searching && Keyboard.dismiss()}
        >
          <View style={desktop && styles.desktopColumn}>
        <FeedRow selected={desktopSource?.kind === 'all'} title={t('allArticles')} count={allArticleCount} icon="reader-outline" color={themeColors.text} onPress={() => selectDesktopSource({ title: t('allArticles') }, 'all')} />
            <Text style={[screenStyles.sectionTitle, { color: themeColors.text }]}>{t('categories')}</Text>
            {categories.map(([categoryName, count], index) => (
          <FeedRow
            key={categoryName}
            selected={desktopSource?.kind === 'category' && desktopSource.category === categoryName}
                title={categoryName === UNCATEGORIZED_CATEGORY ? t('uncategorized') : categoryName}
                count={count}
                icon="folder-outline"
                color={categoryName === UNCATEGORIZED_CATEGORY ? '#5B6472' : categoryColors[index % categoryColors.length]}
                onPress={() => selectDesktopSource({ category: categoryName, title: categoryName === UNCATEGORIZED_CATEGORY ? t('uncategorized') : categoryName }, 'category')}
              />
            ))}
          </View>
          <View style={desktop && styles.desktopColumn}>
            <View style={styles.feedSectionHeader}>
              <Text style={[screenStyles.sectionTitle, styles.feedSectionTitle, { color: themeColors.text }]}>{t('myFeeds')}</Text>
              {/* <Pressable disabled={refreshNames.isPending || allFeeds.length === 0} onPress={() => refreshNames.mutate(allFeeds)}>
            <Text style={[styles.batchNameButton, { color: refreshNames.isPending || allFeeds.length === 0 ? themeColors.subtle : themeColors.blue }]}>
              {refreshNames.isPending ? t('refreshing') : t('testUpdateFeedNames')}
            </Text>
          </Pressable> */}
            </View>
            {visibleFeeds.map((item, index) => (
          <FeedRow
            key={item.id}
            selected={desktopSource?.kind === 'feed' && desktopSource.feedId === item.feedId}
                title={item.title}
                count={getFeedArticleCount(item, allArticles)}
                imageUrl={getFeedIconUrl(item.siteUrl, item.url)}
                color={categoryColors[index % categoryColors.length]}
                onPress={() => selectDesktopSource({ category: parseFeedCategories(item.category)[0], feedId: item.feedId, feedRecordId: item.id, title: item.title }, 'feed')}
                onLongPress={() => openFeedActions(item)}
                onEdit={() => openEditFeed(item)}
                onDelete={() => confirmRemoveFeed(item)}
              />
            ))}
          </View>
        </ScrollView>}
        {desktop && desktopSource && <DesktopArticleLayout enabled selectedArticleId={selectedArticleId} onCloseArticle={() => selectArticle(null)}>
          <View style={styles.desktopArticleList}>
            <View style={styles.desktopListHeader}>
              <IconButton name="chevron-back" onPress={clearDesktopSource} />
              <Text numberOfLines={1} style={[styles.desktopListTitle, { color: themeColors.text }]}>{desktopSource.title}</Text>
            </View>
            {sourceArticles.isError ? <QueryState title={t('articleLoadFailed')} message={sourceArticles.error instanceof Error ? sourceArticles.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={() => sourceArticles.refetch()} /> : <FlatList
              data={sourceArticleItems}
              keyExtractor={(item) => item.id}
              onEndReached={() => { if (sourceArticles.hasNextPage && !sourceArticles.isFetchingNextPage) void sourceArticles.fetchNextPage(); }}
              onEndReachedThreshold={0.5}
              contentContainerStyle={styles.desktopArticleContent}
              ListEmptyComponent={sourceArticles.isLoading ? <QueryState title={t('articlesLoading')} /> : <QueryState title={t('noArticles')} message={t('noArticlesInCategory')} />}
            renderItem={({ item }) => <ArticleRow article={item} selected={selectedArticleId === item.id} hidePreviewActions={Boolean(selectedArticleId)} onPress={() => selectArticle(item.id)} onToggleStar={() => toggleArticleStar.mutate(item.id)} />}
            />}
          </View>
        </DesktopArticleLayout>}
      </View>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={t('addFeed')}
        style={({ pressed }) => [styles.floatingAddButton, { backgroundColor: themeColors.blue }, desktop && styles.desktopHidden, pressed && styles.floatingAddButtonPressed]}
        onPress={() => {
          setImportProgress(null);
          setAddVisible(true);
        }}
      >
        <Ionicons name='add' size={30} color='#FFFFFF' />
      </Pressable>
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
  desktopWorkspace: { flex: 1, flexDirection: 'row', overflow: 'hidden' },
  desktopSources: { width: '40%', maxWidth: 440, minWidth: 280, flexGrow: 0, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border },
  desktopArticleList: { flex: 1, minWidth: 0 },
  desktopArticleContent: { paddingHorizontal: 16, paddingBottom: 32 },
  desktopListHeader: { height: 64, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center' },
  desktopListTitle: { flex: 1, marginLeft: 6, fontSize: 18, fontWeight: '800' },
  desktopColumns: { flexDirection: 'column' },
  desktopColumn: { width: '100%', flexGrow: 0, flexShrink: 0, minWidth: 0 },
  desktopSearch: { width: 260, height: 40, marginLeft: 16, borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, paddingHorizontal: 14, outlineStyle: 'none' } as any,
  searchCancel: { marginLeft: 12 },
  desktopAdd: { height: 40, borderRadius: 8, paddingHorizontal: 16, marginLeft: 12, flexDirection: 'row', alignItems: 'center' },
  desktopAddText: { color: '#fff', fontWeight: '700', marginLeft: 6 },
  desktopHidden: { display: 'none' },
  feedSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    marginBottom: 7,
  },
  feedSectionTitle: {
    marginTop: 0,
    marginBottom: 0,
  },
  batchNameButton: {
    fontSize: 13,
    fontWeight: '700',
  },
  scrollContent: {
    paddingBottom: 96,
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
  floatingAddButton: {
    position: 'absolute',
    right: 22,
    bottom: 22,
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.24,
    shadowRadius: 5,
  },
  floatingAddButtonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.96 }],
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
