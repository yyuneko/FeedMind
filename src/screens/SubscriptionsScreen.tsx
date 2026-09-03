import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useMemo, useState } from 'react';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AutofillSafeTextInput as TextInput } from '@/components/AutofillSafeTextInput';
import { QueryState } from '@/components/QueryState';
import { SourceSelector } from '@/components/SourceSelector';
import { articleRepo, libraryRepo } from '@/api/repositories';
import { addFeed, importFeedsFromOpmlUrl, isOpmlUrl } from '@/services/remoteRss';
import type { LibraryCategory, LibraryFeed } from '@/types';
import { t } from '@/i18n';
import { radius, spacing, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

type Row = { kind: 'category'; category: LibraryCategory | null } | { kind: 'feed'; feed: LibraryFeed };
export function SubscriptionsScreen() {
  const colors = useThemeColors(); const client = useQueryClient();
  const tree = useQuery({ queryKey: ['library-tree'], queryFn: libraryRepo.tree, staleTime: Infinity });
  const [addOpen, setAddOpen] = useState(false); const [addKind, setAddKind] = useState<'feed' | 'article'>('feed'); const [name, setName] = useState(''); const [url, setUrl] = useState(''); const [categoryId, setCategoryId] = useState<string | null>(null);
  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    for (const category of (tree.data?.categories ?? []) as LibraryCategory[]) { result.push({ kind: 'category', category }); result.push(...category.feeds.map((feed: LibraryFeed) => ({ kind: 'feed' as const, feed }))); }
    result.push({ kind: 'category', category: null }); result.push(...((tree.data?.uncategorized.feeds ?? []) as LibraryFeed[]).map((feed: LibraryFeed) => ({ kind: 'feed' as const, feed })));
    return result;
  }, [tree.data]);
  const add = useMutation<unknown, Error, void>({ mutationFn: () => addKind === 'article' ? articleRepo.add({ title: name, url }) : isOpmlUrl(url)
    ? importFeedsFromOpmlUrl(url, tree.data?.categories.find((item: LibraryCategory) => item.id === categoryId)?.name ?? '')
    : addFeed({ title: name, url }, '', categoryId ?? undefined), onSuccess: async () => { setAddOpen(false); setName(''); setUrl(''); await client.refetchQueries({ queryKey: ['library-tree'], type: 'active' }); }, onError: (error) => Alert.alert(t('addFailed'), error.message) });
  return <SafeAreaView style={[screenStyles.safe, { backgroundColor: colors.background }]}>
    <View style={screenStyles.header}><Text style={[screenStyles.title, { color: colors.text }]}>{t('feeds')}</Text><Pressable accessibilityLabel={t('categories')} onPress={() => router.push('/categories')}><Ionicons name="folder-open-outline" size={22} color={colors.secondary} /></Pressable><Pressable accessibilityLabel={t('addArticle')} onPress={() => { setAddKind('article'); setAddOpen(true); }}><Ionicons name="document-text-outline" size={22} color={colors.secondary} /></Pressable><Pressable accessibilityLabel={t('addFeed')} onPress={() => { setAddKind('feed'); setAddOpen(true); }}><Ionicons name="add" size={25} color={colors.blue} /></Pressable></View>
    <SourceSelector />
    {tree.isLoading ? <QueryState title={t('feedLoading')} loading /> : <FlatList data={rows} keyExtractor={(item) => item.kind === 'category' ? `c:${item.category?.id ?? 'none'}` : `f:${item.feed.id}`}
      renderItem={({ item }) => item.kind === 'category' ? <Pressable style={[styles.category, { backgroundColor: colors.page }]} onPress={() => item.category && router.push(`/category/${item.category.id}` as never)}><Text style={[styles.categoryText, { color: colors.text }]}>{item.category?.name ?? t('uncategorized')}</Text><Text style={{ color: colors.secondary }}>{item.category?.unreadCount ?? tree.data?.uncategorized.unreadCount ?? 0}</Text></Pressable>
        : <View style={styles.feedRow}><Pressable style={styles.feedMain} onPress={() => router.push(`/feed/${item.feed.id}` as never)}><Ionicons name="logo-rss" size={17} color={colors.secondary} /><Text numberOfLines={1} style={[styles.feedText, { color: colors.text }]}>{item.feed.title}</Text><Text style={{ color: colors.secondary }}>{item.feed.unreadCount}</Text></Pressable><Pressable accessibilityLabel={t('editFeed')} onPress={() => router.push(`/feed/${item.feed.id}/edit` as never)}><Ionicons name="ellipsis-horizontal" size={20} color={colors.secondary} /></Pressable></View>} />}
    <Modal visible={addOpen} transparent animationType="slide" onRequestClose={() => setAddOpen(false)}><Pressable style={[styles.backdrop, { backgroundColor: colors.scrim }]} onPress={() => setAddOpen(false)}><View style={[styles.sheet, { backgroundColor: colors.card }]} onStartShouldSetResponder={() => true}>
      <Text style={[styles.sheetTitle, { color: colors.text }]}>{addKind === 'article' ? t('addArticle') : t('addFeed')}</Text><TextInput value={name} onChangeText={setName} placeholder={addKind === 'article' ? t('articleTitleOptional') : t('feedName')} style={[styles.input, { color: colors.text, borderColor: colors.border }]} /><TextInput value={url} onChangeText={setUrl} placeholder={addKind === 'article' ? t('articleUrl') : t('rssUrl')} autoCapitalize="none" style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
      {addKind === 'feed' ? <View style={styles.choices}><Pressable onPress={() => setCategoryId(null)}><Text style={{ color: !categoryId ? colors.blue : colors.text }}>{t('uncategorized')}</Text></Pressable>{tree.data?.categories.map((item: LibraryCategory) => <Pressable key={item.id} onPress={() => setCategoryId(item.id)}><Text style={{ color: categoryId === item.id ? colors.blue : colors.text }}>{item.name}</Text></Pressable>)}</View> : null}
      <Pressable disabled={!url.trim() || add.isPending} style={[styles.addButton, { backgroundColor: colors.blue }]} onPress={() => add.mutate()}><Text style={{ color: '#fff' }}>{add.isPending ? t('adding') : t('add')}</Text></Pressable>
    </View></Pressable></Modal>
  </SafeAreaView>;
}
const styles = StyleSheet.create({ category: { minHeight: 44, paddingHorizontal: spacing.xl, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, categoryText: { fontWeight: '700' }, feedRow: { minHeight: 48, paddingHorizontal: spacing.xl, flexDirection: 'row', alignItems: 'center', gap: spacing.md }, feedMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.md }, feedText: { flex: 1 }, backdrop: { flex: 1, justifyContent: 'flex-end' }, sheet: { padding: spacing.xxl, paddingBottom: 36, gap: spacing.lg, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet }, sheetTitle: { fontSize: 20, fontWeight: '700' }, input: { height: 46, borderWidth: 1, borderRadius: radius.control, paddingHorizontal: spacing.lg }, choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg }, addButton: { height: 46, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' } });
