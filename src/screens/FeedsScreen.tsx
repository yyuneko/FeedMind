import { Alert, FlatList, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AutofillSafeTextInput as TextInput } from '@/components/AutofillSafeTextInput';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams, usePathname } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FeedRow } from '@/components/FeedRow';
import { ArticleRow } from '@/components/ArticleRow';
import { DesktopArticleLayout } from '@/components/DesktopArticleLayout';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { ListLoadingIndicator } from '@/components/ListLoadingIndicator';
import { SegmentedTabs } from '@/components/SegmentedTabs';
import { SearchField } from '@/components/SearchField';
import { articleRepo, connectionRepo, feedRepo, sourceSelectionRepo } from '@/api/repositories';
import { t } from '@/i18n';
import { addFeed, importFeedsFromOpmlUrl, isOpmlUrl, refreshFeed, refreshFeedTitle, type OpmlImportProgress } from '@/services/remoteRss';
import { useAppStore } from '@/store/appStore';
import type { Article, Feed, SourceConnection } from '@/types';
import { formatEditableFeedCategories, parseFeedCategories, serializeFeedCategories, UNCATEGORIZED_CATEGORY } from '@/utils/categories';
import { getFeedIconUrl } from '@/utils/html';
import { confirmDestructiveAction } from '@/utils/confirmAction';
import { colors, radius, spacing, typography, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { type FeedSourceSelection, useNavigationStore } from '@/store/navigationStore';
import { useRoutedArticleSelection } from '@/hooks/useRoutedArticleSelection';
import { articlePageItems, articlePageTotal, useArticlePages } from '@/hooks/useArticlePages';

type ImportProgressState = OpmlImportProgress | null;
type FeedSortMode = 'added' | 'alphabetical';
type AddMode = 'feed' | 'article';

const getFeedArticleCount = (feed: Feed, articles: Article[]) => {
  const count = Number(feed.articleCount);
  return Number.isFinite(count)
    ? count
    : articles.filter((article) => article.feedId === feed.feedId).length;
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
  const [addMode, setAddMode] = useState<AddMode>('feed');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState('');
  const [importProgress, setImportProgress] = useState<ImportProgressState>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [feedSortMode, setFeedSortMode] = useState<FeedSortMode>('added');
  const previousFeedStatuses = useRef(new Map<string, Feed['fetchStatus']>());
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
    placeholderData: (previousData) => previousData,
  });
  const connections = useQuery<SourceConnection[]>({ queryKey: ['connections'], queryFn: connectionRepo.list });
  const selection = useQuery({ queryKey: ['source-selection'], queryFn: sourceSelectionRepo.get, refetchInterval: (query) => {
    const status = query.state.data?.job?.status; return status === 'pending' || status === 'running' ? 2000 : false;
  } });
  const selectSource = useMutation({
    mutationFn: ({ connectionId, migrate }: { connectionId: string; migrate: boolean }) => sourceSelectionRepo.select(connectionId, migrate),
    onSuccess: () => { setDesktopSource(null); queryClient.invalidateQueries(); },
    onError: (error) => Alert.alert('切换失败', error instanceof Error ? error.message : t('soonRetry')),
  });
  const chooseSource = (connection: SourceConnection) => {
    if (connection.id === selection.data?.connection?.id || selectSource.isPending) return;
    if (connection.type === 'direct_rss') { selectSource.mutate({ connectionId: connection.id, migrate: false }); return; }
    Alert.alert(`切换到 ${connection.name}`, '是否把当前来源的订阅、分类、已读和收藏状态同步到该来源？', [
      { text: t('cancel'), style: 'cancel' },
      { text: '仅切换', onPress: () => selectSource.mutate({ connectionId: connection.id, migrate: false }) },
      { text: '切换并同步', onPress: () => selectSource.mutate({ connectionId: connection.id, migrate: true }) },
    ]);
  };
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
      void queryClient.invalidateQueries({ queryKey: ['source-selection'] });
    }, [queryClient]),
  );
  const mutation = useMutation({
    mutationFn: async (input: { mode: AddMode; title: string; url: string; category: string }) => {
      if (input.mode === 'article') {
        setImportProgress(null);
        return { kind: 'article' as const, article: await articleRepo.add({ title: input.title, url: input.url }) };
      }
      if (isOpmlUrl(input.url)) {
        setImportProgress({ total: 0, done: 0, imported: 0, failed: 0 });
        return { kind: 'opml' as const, ...(await importFeedsFromOpmlUrl(input.url, input.category, setImportProgress)) };
      }
      setImportProgress(null);
      return { kind: 'feed' as const, feed: await addFeed({ title: input.title, url: input.url }, input.category) };
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
      } else if (result.kind === 'article') {
        Alert.alert(t('articleAdded'));
      }
    },
    onError: (error) => {
      setImportProgress(null);
      Alert.alert(t('addFailed'), error instanceof Error ? error.message : t(addMode === 'article' ? 'checkArticleUrl' : 'checkRssUrl'));
    },
  });
  const removeFeed = useMutation({
    mutationFn: (id: string) => feedRepo.remove(id),
    onSuccess: (_result, deletedId) => {
      queryClient.invalidateQueries();
      if (desktopSource?.kind === 'feed' && desktopSource.feedRecordId === deletedId) {
        setDesktopSource(null);
        router.replace('/feeds');
      }
    },
    onError: (error) => Alert.alert(t('deleteFailed'), error instanceof Error ? error.message : t('soonRetry')),
  });
  const retryFeed = useMutation({
    mutationFn: refreshFeed,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['feeds'] }),
    onError: (error) => Alert.alert(t('refreshFailed'), error instanceof Error ? error.message : t('soonRetry')),
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
  const legacyFeeds: Feed[] = feeds.data ?? [];
  const externalSourceIds = new Set<string>();
  const allFeeds: Feed[] = legacyFeeds;
  useEffect(() => {
    const nextStatuses = new Map<string, Feed['fetchStatus']>();
    let completed = false;
    for (const feed of allFeeds) {
      const previousStatus = previousFeedStatuses.current.get(feed.feedId);
      if ((previousStatus === 'pending' || previousStatus === 'fetching') && feed.fetchStatus === 'ok') {
        completed = true;
      }
      nextStatuses.set(feed.feedId, feed.fetchStatus);
    }
    previousFeedStatuses.current = nextStatuses;
    if (completed) void queryClient.invalidateQueries({ queryKey: ['articles'] });
  }, [allFeeds, queryClient]);
  const allArticles = articlePageItems(articles.data);
  const allArticleCount = articlePageTotal(articles.data);
  const sourceArticleItems = articlePageItems(sourceArticles.data);
  const normalizedQuery = debouncedQuery.trim().toLowerCase();
  const visibleFeeds = [...allFeeds].sort((left, right) => {
    const titleOrder = left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: 'base' });
    if (feedSortMode === 'alphabetical') return titleOrder || left.id.localeCompare(right.id);

    const leftCreatedAt = Date.parse(left.createdAt);
    const rightCreatedAt = Date.parse(right.createdAt);
    const addedOrder = (Number.isNaN(rightCreatedAt) ? 0 : rightCreatedAt) - (Number.isNaN(leftCreatedAt) ? 0 : leftCreatedAt);
    return addedOrder || titleOrder || left.id.localeCompare(right.id);
  });
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
  const isImportingOpml = addMode === 'feed' && mutation.isPending && isOpmlUrl(url);
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
  const selectedFeed = desktopSource?.kind === 'feed'
    ? allFeeds.find((item) => !externalSourceIds.has(item.feedId)
      && (item.id === desktopSource.feedRecordId || item.feedId === desktopSource.feedId))
    : undefined;

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
          <Text style={[screenStyles.title, { color: themeColors.text }]}>{t('feeds')}</Text>
        )}
        {searching && !desktop ? <Pressable style={styles.searchCancel} onPress={() => { setQuery(''); setSearching(false); }}><Text style={{ color: themeColors.blue }}>{t('cancel')}</Text></Pressable> : desktop ? <><IconButton name='git-network-outline' label="数据源连接" onPress={() => router.push('/source-connections')} /><SearchField value={query} onChangeText={setQuery} placeholder={t('search')} style={styles.desktopSearch} /><Pressable accessibilityRole="button" style={({ pressed }) => [styles.desktopAdd, { backgroundColor: pressed ? themeColors.pressed : themeColors.blue }]} onPress={() => setAddVisible(true)}><Ionicons name="add" size={18} color="#fff" /><Text style={styles.desktopAddText}>{t('addContent')}</Text></Pressable></> : <View style={{ flexDirection: 'row' }}><IconButton name='git-network-outline' label="数据源连接" onPress={() => router.push('/source-connections')} /><IconButton name="search-outline" label={t('search')} onPress={() => setSearching(true)} /></View>}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sourceSelector}>
        {(connections.data ?? []).map((connection: SourceConnection) => {
          const active = connection.id === selection.data?.connection?.id;
          return <Pressable key={connection.id} accessibilityRole="button" accessibilityState={{ selected: active }}
            style={[styles.sourceChoice, { borderColor: active ? themeColors.blue : themeColors.border, backgroundColor: active ? themeColors.pill : themeColors.card }]}
            onPress={() => chooseSource(connection)}>
            <Ionicons name={connection.type === 'direct_rss' ? 'cloud-outline' : 'git-network-outline'} size={15} color={active ? themeColors.blue : themeColors.secondary} />
            <Text style={{ color: active ? themeColors.blue : themeColors.secondary, fontWeight: active ? '700' : '500' }}>{connection.type === 'direct_rss' ? '当前系统' : connection.name}</Text>
          </Pressable>;
        })}
      </ScrollView>
      {selection.data?.job && ['pending', 'running', 'partial', 'failed'].includes(selection.data.job.status) ? <View style={[styles.switchStatus, { backgroundColor: themeColors.pill }]}>
        <Text style={{ color: themeColors.secondary }}>数据源迁移：{selection.data.job.succeededCount}/{selection.data.job.totalCount}，失败 {selection.data.job.failedCount}，跳过 {selection.data.job.skippedCount}</Text>
        {selection.data.job.failedCount > 0 || selection.data.job.status === 'failed' ? <Pressable onPress={() => sourceSelectionRepo.retry(selection.data!.job!.id).then(() => queryClient.invalidateQueries({ queryKey: ['source-selection'] }))}><Text style={{ color: themeColors.blue }}>重试失败项</Text></Pressable> : null}
      </View> : null}
      <View style={desktop ? styles.desktopWorkspace : screenStyles.flex}>
        {(!desktop || !selectedArticleId || !desktopSource) && <ScrollView
          style={desktop && desktopSource ? styles.desktopSources : screenStyles.flex}
          contentContainerStyle={[screenStyles.content, styles.scrollContent, desktop && screenStyles.desktopContent, desktop && styles.desktopColumns]}
          keyboardShouldPersistTaps="handled"
          onTouchStart={() => searching && Keyboard.dismiss()}
        >
          {feeds.isLoading ? <QueryState title={t('feedLoading')} loading /> : feeds.isFetching ? allFeeds.length > 0 ? <ListLoadingIndicator label={t('feedLoading')} /> : null : null}
          <View style={desktop && styles.desktopColumn}>
        <FeedRow selected={desktopSource?.kind === 'all'} title={t('allArticles')} count={allArticleCount} icon="reader-outline" color={themeColors.text} onPress={() => selectDesktopSource({ title: t('allArticles') }, 'all')} />
            <Text style={[screenStyles.sectionTitle, { color: themeColors.text }]}>{t('categories')}</Text>
            {categories.map(([categoryName, count]) => (
          <FeedRow
            key={categoryName}
            selected={desktopSource?.kind === 'category' && desktopSource.category === categoryName}
                title={categoryName === UNCATEGORIZED_CATEGORY ? t('uncategorized') : categoryName}
                count={count}
                icon="folder-outline"
                color={themeColors.secondary}
                onPress={() => selectDesktopSource({ category: categoryName, title: categoryName === UNCATEGORIZED_CATEGORY ? t('uncategorized') : categoryName }, 'category')}
              />
            ))}
          </View>
          <View style={desktop && styles.desktopColumn}>
            <View style={styles.feedSectionHeader}>
              <Text style={[screenStyles.sectionTitle, styles.feedSectionTitle, { color: themeColors.text }]}>{t('myFeeds')}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={feedSortMode === 'added' ? t('sortByAddedTime') : t('sortAlphabetically')} style={({ pressed }) => [styles.feedSortButton, { backgroundColor: pressed ? themeColors.pressed : themeColors.page }]} onPress={() => setFeedSortMode((mode) => mode === 'added' ? 'alphabetical' : 'added')}>
                <Ionicons name="swap-vertical-outline" size={14} color={themeColors.secondary} />
                <Text numberOfLines={1} style={[styles.feedSortText, { color: themeColors.secondary }]}>{feedSortMode === 'added' ? t('sortByAddedTime') : t('sortAlphabetically')}</Text>
              </Pressable>
              {/* <Pressable disabled={refreshNames.isPending || allFeeds.length === 0} onPress={() => refreshNames.mutate(allFeeds)}>
            <Text style={[styles.batchNameButton, { color: refreshNames.isPending || allFeeds.length === 0 ? themeColors.subtle : themeColors.blue }]}>
              {refreshNames.isPending ? t('refreshing') : t('testUpdateFeedNames')}
            </Text>
          </Pressable> */}
            </View>
            {visibleFeeds.map((item) => (
          <FeedRow
            key={item.id}
            selected={desktopSource?.kind === 'feed' && desktopSource.feedId === item.feedId}
                title={item.title}
                count={getFeedArticleCount(item, allArticles)}
                icon={item.fetchStatus === 'error' ? 'refresh-outline' : 'reader-outline'}
                imageUrl={item.fetchStatus === 'error' ? null : getFeedIconUrl(item.siteUrl, item.url)}
                color={item.fetchStatus === 'error' ? themeColors.destructive : themeColors.blue}
                onPress={() => {
                  if (item.fetchStatus === 'error') {
                    if (externalSourceIds.has(item.feedId)) router.push('/source-connections');
                    else if (!retryFeed.isPending) retryFeed.mutate(item);
                    return;
                  }
                  selectDesktopSource({ category: parseFeedCategories(item.category)[0], feedId: item.feedId,
                    feedRecordId: externalSourceIds.has(item.feedId) ? undefined : item.id, title: item.title }, 'feed');
                }}
                onLongPress={externalSourceIds.has(item.feedId) ? undefined : () => openFeedActions(item)}
                onEdit={externalSourceIds.has(item.feedId) ? undefined : () => openEditFeed(item)}
                onDelete={externalSourceIds.has(item.feedId) ? undefined : () => confirmRemoveFeed(item)}
              />
            ))}
          </View>
        </ScrollView>}
        {desktop && desktopSource && <DesktopArticleLayout enabled selectedArticleId={selectedArticleId} onCloseArticle={() => selectArticle(null)}>
          <View style={styles.desktopArticleList}>
            <View style={styles.desktopListHeader}>
              <IconButton name="chevron-back" onPress={clearDesktopSource} />
              <Text numberOfLines={1} style={[styles.desktopListTitle, { color: themeColors.text }]}>{desktopSource.title}</Text>
              {selectedFeed ? (
                <View style={styles.desktopListActions}>
                  <IconButton name="create-outline" onPress={() => openEditFeed(selectedFeed)} />
                  <Pressable style={({ pressed }) => [styles.desktopDeleteButton, pressed && styles.desktopActionPressed]} onPress={() => confirmRemoveFeed(selectedFeed)}>
                    <Ionicons name="trash-outline" size={20} color={themeColors.destructive} />
                  </Pressable>
                </View>
              ) : null}
            </View>
            {sourceArticles.isError ? <QueryState title={t('articleLoadFailed')} message={sourceArticles.error instanceof Error ? sourceArticles.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={() => sourceArticles.refetch()} /> : <FlatList
              data={sourceArticleItems}
              keyExtractor={(item) => item.id}
              onEndReached={() => { if (sourceArticles.hasNextPage && !sourceArticles.isFetchingNextPage) void sourceArticles.fetchNextPage(); }}
              onEndReachedThreshold={0.5}
              contentContainerStyle={styles.desktopArticleContent}
              ListEmptyComponent={sourceArticles.isLoading ? <QueryState title={t('articlesLoading')} loading /> : <QueryState title={t('noArticles')} message={t('noArticlesInCategory')} />}
              ListHeaderComponent={sourceArticles.isFetching && !sourceArticles.isFetchingNextPage && sourceArticleItems.length > 0 ? <ListLoadingIndicator label={t('articlesLoading')} /> : null}
              ListFooterComponent={sourceArticles.isFetchingNextPage ? <ListLoadingIndicator label={t('articlesLoading')} footer /> : null}
            renderItem={({ item }) => <ArticleRow article={item} selected={selectedArticleId === item.id} hidePreviewActions={Boolean(selectedArticleId)} onPress={() => selectArticle(item.id)} onToggleStar={() => toggleArticleStar.mutate(item.id)} />}
            />}
          </View>
        </DesktopArticleLayout>}
      </View>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={t('addContent')}
        style={({ pressed }) => [styles.floatingAddButton, { backgroundColor: themeColors.blue }, desktop && styles.desktopHidden, pressed && styles.floatingAddButtonPressed]}
        onPress={() => {
          setImportProgress(null);
          setAddVisible(true);
        }}
      >
        <Ionicons name='add' size={24} color='#FFFFFF' />
      </Pressable>
      <Modal visible={addVisible} transparent animationType={desktop ? "fade" : "slide"} onRequestClose={() => setAddVisible(false)}>
        <View style={[styles.modalMask, !desktop && styles.sheetMask, { backgroundColor: themeColors.scrim }]}>
          <View style={[styles.modal, !desktop && styles.sheetModal, { backgroundColor: themeColors.card }]}>
            <Text style={[styles.modalTitle, { color: themeColors.text }]}>{t('addContent')}</Text>
            <SegmentedTabs
              items={selection.data?.connection?.type === 'direct_rss' ? [{ label: t('addFeed'), value: 'feed' }, { label: t('addArticle'), value: 'article' }] : [{ label: t('addFeed'), value: 'feed' }]}
              value={addMode}
              onChange={(mode) => { setAddMode(mode); setImportProgress(null); }}
            />
            <TextInput
              value={title}
              onChangeText={setTitle}
              editable={!mutation.isPending}
              placeholder={t(addMode === 'article' ? 'articleTitleOptional' : 'feedName')}
              placeholderTextColor={themeColors.subtle}
              style={[styles.input, styles.addFirstInput, { borderColor: themeColors.border, color: themeColors.text }]}
            />
            <TextInput
              value={url}
              onChangeText={setUrl}
              editable={!mutation.isPending}
              placeholder={t(addMode === 'article' ? 'articleUrl' : 'rssOrOpmlUrl')}
              autoCapitalize="none"
              placeholderTextColor={themeColors.subtle}
              style={[styles.input, styles.editUrlInput, { borderColor: themeColors.border, color: themeColors.text }]}
            />
            {addMode === 'feed' ? <><Text style={[styles.fieldLabel, { color: themeColors.secondary }]}>{t('categories')}</Text>
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
            /></> : null}
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
              <Pressable style={[styles.modalButton, mutation.isPending && styles.disabledButton]} disabled={mutation.isPending} onPress={() => url.trim() && mutation.mutate({ mode: addMode, title, url, category })}>
                <Text style={[screenStyles.link, { color: themeColors.blue }]}>{mutation.isPending ? (isImportingOpml ? t('importing') : t('adding')) : t('add')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  sourceSelector: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
  sourceChoice: { minHeight: 34, paddingHorizontal: spacing.md, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  switchStatus: { marginHorizontal: spacing.lg, marginBottom: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.control, flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  desktopWorkspace: { flex: 1, flexDirection: 'row', overflow: 'hidden' },
  desktopSources: { width: '40%', maxWidth: 440, minWidth: 280, flexGrow: 0, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border },
  desktopArticleList: { flex: 1, minWidth: 0 },
  desktopArticleContent: { paddingHorizontal: 16, paddingBottom: 32 },
  desktopListHeader: { height: 64, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center' },
  desktopListTitle: { flex: 1, marginLeft: 6, fontSize: 18, fontWeight: '800' },
  desktopListActions: { flexDirection: 'row', alignItems: 'center' },
  desktopDeleteButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  desktopActionPressed: { opacity: 0.55 },
  desktopColumns: { flexDirection: 'column' },
  desktopColumn: { width: '100%', flexGrow: 0, flexShrink: 0, minWidth: 0 },
  desktopSearch: { width: 260, flex: 0, marginLeft: spacing.md },
  searchCancel: { marginLeft: 12 },
  desktopAdd: { height: 40, borderRadius: radius.control, paddingHorizontal: spacing.xl, marginLeft: spacing.lg, flexDirection: 'row', alignItems: 'center' },
  desktopAddText: { color: '#fff', ...typography.control, marginLeft: spacing.sm },
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
  feedSortButton: { height: 32, maxWidth: 160, paddingHorizontal: spacing.md, borderRadius: radius.control, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  feedSortText: {
    ...typography.metadata,
  },
  batchNameButton: {
    fontSize: 13,
    fontWeight: '700',
  },
  scrollContent: {
    paddingBottom: 96,
  },
  input: {
    height: 42,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  addFirstInput: {
    marginTop: 14,
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
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.14,
    shadowRadius: 8,
  },
  floatingAddButtonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.96 }],
  },
  modalMask: {
    flex: 1,
    paddingHorizontal: 22,
    backgroundColor: colors.scrim,
    justifyContent: 'center',
  },
  sheetMask: { justifyContent: 'flex-end', paddingHorizontal: 0 },
  modal: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 520,
    borderRadius: radius.panel,
    backgroundColor: colors.card,
    padding: 18,
  },
  sheetModal: { maxWidth: undefined, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingBottom: 28 },
  modalTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
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
