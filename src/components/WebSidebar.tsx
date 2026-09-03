import { Alert, Animated, Easing, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { router, useGlobalSearchParams, usePathname } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { SearchField } from '@/components/SearchField';
import { libraryRepo } from '@/api/repositories';
import { settingsRepo } from '@/db/repositories';
import { getFeedIconUrl } from '@/utils/html';
import type { LibraryCategory, LibraryFeed, LibraryTree } from '@/types';
import { t } from '@/i18n';
import { motion, radius, spacing, typography, useReducedMotion, useThemeColors, zIndex } from '@/utils/theme';

export const WEB_SIDEBAR_WIDTH = 288;
type Node = { kind: 'category'; category: LibraryCategory | null; unreadCount: number } | { kind: 'feed'; feed: LibraryFeed };
const isSelectedFeed = (feed: LibraryFeed) => feed.url === 'feedmind://selected/owner';

function moveFeedInTree(tree: LibraryTree, feedId: string, categoryId: string | null, sortOrder: number): LibraryTree {
  let movedFeed: LibraryFeed | undefined;
  const categories = tree.categories.map((category) => ({
    ...category,
    feeds: category.feeds.filter((feed) => {
      if (feed.id !== feedId) return true;
      movedFeed = feed;
      return false;
    }),
  }));
  const uncategorizedFeeds = tree.uncategorized.feeds.filter((feed) => {
    if (feed.id !== feedId) return true;
    movedFeed = feed;
    return false;
  });
  if (!movedFeed) return tree;
  const nextFeed = { ...movedFeed, categoryId, sortOrder };
  if (categoryId) {
    const target = categories.find((category) => category.id === categoryId);
    if (!target) return tree;
    target.feeds = [...target.feeds, nextFeed];
  } else {
    uncategorizedFeeds.push(nextFeed);
  }
  return { ...tree, categories, uncategorized: { ...tree.uncategorized, feeds: uncategorizedFeeds } };
}

const dragTransfer = (event: any) => event?.dataTransfer ?? event?.nativeEvent?.dataTransfer;

export function WebSidebar() {
  const colors = useThemeColors(); const pathname = usePathname();
  const queryClient = useQueryClient();
  const reducedMotion = useReducedMotion();
  const routeParams = useGlobalSearchParams<Record<string, string>>();
  const openDialog = (dialog: string, target?: string) => router.push({ pathname: pathname as never, params: { ...routeParams, dialog, target } } as never);
  const tree = useQuery({ queryKey: ['library-tree'], queryFn: libraryRepo.tree, staleTime: Infinity });
  const [query, setQuery] = useState(''); const [searchOpen, setSearchOpen] = useState(false); const [hoveredFeedId, setHoveredFeedId] = useState<string | null>(null); const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draggedFeedId, setDraggedFeedId] = useState<string | null>(null); const [dropCategoryKey, setDropCategoryKey] = useState<string | null>(null);
  const searchProgress = useRef(new Animated.Value(0)).current;
  useEffect(() => { settingsRepo.get('webSidebarExpanded').then((value) => { if (value) setExpanded(new Set(JSON.parse(value) as string[])); }).catch(() => undefined); }, []);
  useEffect(() => {
    if (!searchOpen) { searchProgress.setValue(0); return; }
    Animated.timing(searchProgress, { toValue: 1, duration: reducedMotion ? 0 : motion.duration.fast, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [reducedMotion, searchOpen, searchProgress]);
  const toggle = (key: string) => setExpanded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); void settingsRepo.set('webSidebarExpanded', JSON.stringify([...next])); return next; });
  const normalized = query.trim().toLocaleLowerCase();
  const nodes = useMemo(() => {
    const result: Node[] = [];
    const groups: Array<{ category: LibraryCategory | null; feeds: LibraryFeed[]; unreadCount: number }> = [
      ...(tree.data?.categories.map((category: LibraryCategory) => ({ category, feeds: category.feeds, unreadCount: category.unreadCount })) ?? []),
      { category: null, feeds: tree.data?.uncategorized.feeds ?? [], unreadCount: tree.data?.uncategorized.unreadCount ?? 0 },
    ];
    const selectedFeeds = groups.flatMap((group) => group.feeds).filter(isSelectedFeed);
    const visibleSelectedFeeds = normalized
      ? selectedFeeds.filter((feed) => feed.title.toLocaleLowerCase().includes(normalized) || (feed.url ?? '').toLocaleLowerCase().includes(normalized))
      : selectedFeeds;
    result.push(...visibleSelectedFeeds.map((feed) => ({ kind: 'feed' as const, feed })));
    for (const group of groups) {
      const categoryName = group.category?.name ?? t('uncategorized');
      const categoryMatch = normalized && categoryName.toLocaleLowerCase().includes(normalized);
      const regularFeeds = group.feeds.filter((feed) => !isSelectedFeed(feed));
      const feeds = normalized ? regularFeeds.filter((feed) => categoryMatch || feed.title.toLocaleLowerCase().includes(normalized) || (feed.url ?? '').toLocaleLowerCase().includes(normalized)) : regularFeeds;
      if (normalized && !categoryMatch && !feeds.length) continue;
      if (!group.category && !regularFeeds.length) continue;
      const selectedUnreadCount = group.feeds.reduce((count, feed) => count + (isSelectedFeed(feed) ? feed.unreadCount : 0), 0);
      result.push({ kind: 'category', category: group.category, unreadCount: Math.max(0, group.unreadCount - selectedUnreadCount) });
      const key = group.category?.id ?? 'uncategorized';
      if (normalized || expanded.has(key)) result.push(...feeds.map((feed) => ({ kind: 'feed' as const, feed })));
    }
    return result;
  }, [expanded, normalized, tree.data]);
  const nav = [
    { path: '/all', label: t('all'), icon: 'albums-outline' as const },
    { path: '/recent', label: t('recentReading'), icon: 'time-outline' as const },
    { path: '/saved', label: t('saved'), icon: 'bookmark-outline' as const },
  ];
  const selectedVisible = !normalized || nodes.some((item) => item.kind === 'category'
    ? pathname === `/category/${item.category?.id ?? 'uncategorized'}`
    : pathname === `/feed/${item.feed.id}`);
  const moveFeed = async (feedId: string, categoryId: string | null) => {
    const previous = queryClient.getQueryData<LibraryTree>(['library-tree']);
    const feed = previous && [...previous.categories.flatMap((category) => category.feeds), ...previous.uncategorized.feeds].find((item) => item.id === feedId);
    if (!previous || !feed || feed.categoryId === categoryId) return;
    const targetFeeds = categoryId ? previous.categories.find((category) => category.id === categoryId)?.feeds : previous.uncategorized.feeds;
    if (!targetFeeds) return;
    const sortOrder = targetFeeds.reduce((maximum, item) => Math.max(maximum, item.sortOrder), -1) + 1;
    queryClient.setQueryData<LibraryTree>(['library-tree'], moveFeedInTree(previous, feedId, categoryId, sortOrder));
    try {
      await libraryRepo.updateFeed(feedId, { categoryId, sortOrder });
      await queryClient.invalidateQueries({ queryKey: ['library-tree'] });
    } catch (error) {
      queryClient.setQueryData(['library-tree'], previous);
      Alert.alert(t('updateFailed'), error instanceof Error ? error.message : t('soonRetry'));
    }
  };
  const categoryDragProps = (categoryId: string | null) => {
    const key = categoryId ?? 'uncategorized';
    return {
      onDragEnter: (event: any) => { event.preventDefault?.(); setDropCategoryKey(key); },
      onDragOver: (event: any) => { event.preventDefault?.(); const transfer = dragTransfer(event); if (transfer) transfer.dropEffect = 'move'; },
      onDragLeave: (event: any) => { if (!event.currentTarget?.contains?.(event.relatedTarget)) setDropCategoryKey((current) => current === key ? null : current); },
      onDrop: (event: any) => {
        event.preventDefault?.();
        const feedId = draggedFeedId ?? dragTransfer(event)?.getData?.('text/plain');
        setDropCategoryKey(null); setDraggedFeedId(null);
        if (feedId) void moveFeed(feedId, categoryId);
      },
    };
  };
  return <View style={[styles.sidebar, { backgroundColor: colors.card, borderRightColor: colors.border }]}>
    <View style={styles.logoRow}><Image source={require('../../assets/favicon.png')} style={styles.logo} /><Text style={[styles.brand, { color: colors.text }]}>FeedMind</Text></View>
    <View style={styles.primary}>{nav.map((item) => <NavRow key={item.path} active={pathname === item.path} icon={item.icon} label={item.label} onPress={() => router.push(item.path as never)} />)}</View>
    <View style={styles.subscriptionHeader}>
      <View style={styles.subscriptionSearchArea}>
        <Pressable style={styles.subscriptionTitle} onPress={() => router.push('/subscriptions')}><Ionicons name="folder-open-outline" size={18} color={pathname === '/subscriptions' ? colors.blue : colors.secondary} /><Text style={[styles.sectionLabel, { color: pathname === '/subscriptions' ? colors.blue : colors.text }]}>{t('feeds')}</Text></Pressable>
        {!searchOpen ? <Pressable accessibilityRole="button" accessibilityLabel={t('searchFeeds')} accessibilityState={{ expanded: false }} style={[styles.headerButton, styles.searchButton]} onPress={() => setSearchOpen(true)}><Ionicons name="search-outline" size={18} color={colors.secondary} /></Pressable> : null}
        {searchOpen ? <Animated.View style={[styles.inlineSearch, { backgroundColor: colors.card, width: searchProgress.interpolate({ inputRange: [0, 1], outputRange: ['24%', '100%'] }), opacity: searchProgress }]}>
          <SearchField autoFocus value={query} onChangeText={setQuery} placeholder={t('searchFeeds')} onEscape={() => { if (query) setQuery(''); else setSearchOpen(false); }} style={styles.feedSearch} />
          <Pressable accessibilityRole="button" accessibilityLabel={t('close')} style={styles.inlineSearchClose} onPress={() => { setQuery(''); setSearchOpen(false); }}><Ionicons name="close" size={18} color={colors.secondary} /></Pressable>
        </Animated.View> : null}
      </View>
      <Pressable accessibilityLabel={t('newCategory')} onPress={() => openDialog('new-category')}><Ionicons name="folder-outline" size={18} color={colors.secondary} /></Pressable>
      <Pressable accessibilityLabel={t('addArticle')} onPress={() => openDialog('add-article')}><Ionicons name="document-text-outline" size={18} color={colors.secondary} /></Pressable>
      <Pressable accessibilityLabel={t('addFeed')} onPress={() => openDialog('add-feed')}><Ionicons name="add" size={20} color={colors.blue} /></Pressable>
    </View>
    {!selectedVisible && (pathname.startsWith('/feed/') || pathname.startsWith('/category/')) ? <View style={[styles.searchNotice, { backgroundColor: colors.page }]}><Text style={[styles.noticeText, { color: colors.secondary }]}>{t('currentItemNotInResults')}</Text><Pressable onPress={() => setQuery('')}><Text style={{ color: colors.blue }}>{t('locate')}</Text></Pressable></View> : null}
    <FlatList style={styles.tree} contentContainerStyle={styles.treeContent} data={nodes} {...({ dataSet: { scrollbar: 'feedmind' } } as any)} keyExtractor={(item) => item.kind === 'category' ? `category:${item.category?.id ?? 'none'}` : `feed:${item.feed.id}`}
      ListEmptyComponent={!tree.isLoading ? <Text style={[styles.empty, { color: colors.secondary }]}>{t('noFeedSearchResults')}</Text> : null}
      renderItem={({ item }) => item.kind === 'category' ? <View style={[styles.categoryRow, dropCategoryKey === (item.category?.id ?? 'uncategorized') && { backgroundColor: colors.selected }]} {...(categoryDragProps(item.category?.id ?? null) as any)}>
        <Pressable accessibilityLabel={t('toggleCategory')} style={styles.chevron} onPress={() => toggle(item.category?.id ?? 'uncategorized')}><Ionicons name={(normalized || expanded.has(item.category?.id ?? 'uncategorized')) ? 'chevron-down' : 'chevron-forward'} size={15} color={colors.secondary} /></Pressable>
        <Pressable style={styles.nodeMain} onPress={() => item.category ? router.push(`/category/${item.category.id}` as never) : router.push('/category/uncategorized' as never)}><Text numberOfLines={1} style={[styles.nodeText, { color: pathname === `/category/${item.category?.id ?? 'uncategorized'}` ? colors.blue : colors.text }]}>{item.category?.name ?? t('uncategorized')}</Text><Text style={{ color: colors.secondary }}>{item.unreadCount}</Text></Pressable>
        {item.category ? <Pressable style={styles.menuButton} onPress={() => openDialog('edit-category', item.category!.id)}><Ionicons name="ellipsis-horizontal" size={16} color={colors.secondary} /></Pressable> : null}
      </View> : <View style={[styles.feedRow, draggedFeedId === item.feed.id && styles.draggedFeedRow]} {...({
        draggable: !isSelectedFeed(item.feed),
        onDragStart: (event: any) => { if (isSelectedFeed(item.feed)) { event.preventDefault?.(); return; } const transfer = dragTransfer(event); if (transfer) { transfer.effectAllowed = 'move'; transfer.setData('text/plain', item.feed.id); } setDraggedFeedId(item.feed.id); },
        onDragEnd: () => { setDraggedFeedId(null); setDropCategoryKey(null); },
        onMouseEnter: () => setHoveredFeedId(item.feed.id), onMouseLeave: () => setHoveredFeedId((current) => current === item.feed.id ? null : current),
      } as any)}>
        <Pressable style={styles.nodeMain} onPress={() => router.push(`/feed/${item.feed.id}` as never)}>
          <View style={[styles.feedIcon, { backgroundColor: colors.page }]}>{getFeedIconUrl(item.feed.siteUrl, item.feed.url) ? <Image source={{ uri: getFeedIconUrl(item.feed.siteUrl, item.feed.url)! }} style={styles.feedIconImage} /> : <Ionicons name="logo-rss" size={11} color={colors.secondary} />}</View>
          <Text numberOfLines={1} style={[styles.feedText, { color: pathname === `/feed/${item.feed.id}` ? colors.blue : colors.text }]}>{item.feed.title}</Text><Text style={{ color: colors.secondary }}>{item.feed.unreadCount}</Text>
        </Pressable>
        {!isSelectedFeed(item.feed) ? <Pressable pointerEvents={hoveredFeedId === item.feed.id ? 'auto' : 'none'} accessibilityLabel={t('editFeed')} style={[styles.feedMenuButton, { backgroundColor: colors.card }, hoveredFeedId !== item.feed.id && styles.feedMenuButtonHidden]} onPress={() => openDialog('edit-feed', item.feed.id)}><Ionicons name="ellipsis-horizontal" size={16} color={colors.secondary} /></Pressable> : null}
      </View>} />
    <View style={[styles.footer, { borderTopColor: colors.border }]}><NavRow active={pathname.startsWith('/settings')} icon="settings-outline" label={t('settings')} onPress={() => router.push('/settings')} /></View>
  </View>;
}

const NavRow = ({ active, icon, label, onPress }: { active: boolean; icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) => { const colors = useThemeColors(); return <Pressable style={[styles.navRow, active && { backgroundColor: colors.selected }]} onPress={onPress}><View style={styles.navIcon}><Ionicons name={icon} size={18} color={active ? colors.blue : colors.secondary} /></View><Text style={[styles.navText, { color: active ? colors.blue : colors.text }]}>{label}</Text></Pressable>; };
const styles = StyleSheet.create({
  sidebar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: WEB_SIDEBAR_WIDTH, zIndex: zIndex.navigation, borderRightWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.xl, paddingVertical: spacing.md },
  logoRow: { height: 40, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm }, logo: { width: 26, height: 26, borderRadius: radius.small }, brand: { ...typography.navigationTitle, marginLeft: spacing.md },
  primary: { gap: 2, marginTop: spacing.md }, navRow: { height: 34, borderRadius: radius.control, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center' }, navIcon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }, navText: { ...typography.body, fontWeight: '600', marginLeft: spacing.sm },
  subscriptionHeader: { height: 38, marginTop: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md }, subscriptionSearchArea: { flex: 1, height: 36, position: 'relative', justifyContent: 'center' }, subscriptionTitle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingRight: 30 }, sectionLabel: { ...typography.body, fontWeight: '700' }, headerButton: { alignItems: 'center', justifyContent: 'center' }, searchButton: { position: 'absolute', right: 0, width: 24, height: 36 },
  inlineSearch: { position: 'absolute', top: 0, right: 0, bottom: 0, zIndex: 1, flexDirection: 'row', alignItems: 'center' }, inlineSearchClose: { width: 28, height: 36, alignItems: 'center', justifyContent: 'center' },
  feedSearch: { height: 36 }, tree: { flex: 1, marginHorizontal: -spacing.xl }, treeContent: { paddingHorizontal: spacing.xl }, categoryRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', borderRadius: radius.small }, feedRow: { minHeight: 36, paddingLeft: 27, flexDirection: 'row', alignItems: 'center', position: 'relative' }, draggedFeedRow: { opacity: 0.45 }, chevron: { width: 27, height: 36, alignItems: 'center', justifyContent: 'center' }, nodeMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }, nodeText: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '600' }, feedText: { flex: 1, minWidth: 0, fontSize: 13 }, menuButton: { width: 28, height: 34, alignItems: 'center', justifyContent: 'center' }, feedMenuButton: { position: 'absolute', top: 1, right: 0, zIndex: 1, width: 28, height: 34, alignItems: 'center', justifyContent: 'center' }, feedMenuButtonHidden: { opacity: 0 }, feedIcon: { width: 18, height: 18, marginRight: spacing.sm, borderRadius: 4, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, feedIconImage: { width: 18, height: 18 }, empty: { paddingVertical: spacing.xl, textAlign: 'center', fontSize: 12 },
  searchNotice: { padding: spacing.sm, marginBottom: spacing.sm, borderRadius: radius.small, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }, noticeText: { flex: 1, fontSize: 11 },
  footer: { paddingTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
});
