import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useEffect, useState } from 'react';
import { router, useGlobalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AutofillSafeTextInput as TextInput } from '@/components/AutofillSafeTextInput';
import { articleRepo, libraryRepo } from '@/api/repositories';
import { addFeed, importFeedsFromOpmlUrl, isOpmlUrl } from '@/services/remoteRss';
import { t } from '@/i18n';
import type { LibraryCategory, LibraryFeed } from '@/types';
import { radius, spacing, useThemeColors } from '@/utils/theme';

export function WebLibraryDialogs() {
  const colors = useThemeColors(); const queryClient = useQueryClient();
  const params = useGlobalSearchParams<{ dialog?: string; target?: string }>();
  const tree = useQuery({ queryKey: ['library-tree'], queryFn: libraryRepo.tree, staleTime: Infinity });
  const feeds = [...(tree.data?.categories.flatMap((item: LibraryCategory) => item.feeds) ?? []), ...(tree.data?.uncategorized.feeds ?? [])] as LibraryFeed[];
  const feed = feeds.find((item: LibraryFeed) => item.id === params.target || item.subscriptionId === params.target); const category = tree.data?.categories.find((item: LibraryCategory) => item.id === params.target);
  const [name, setName] = useState(''); const [url, setUrl] = useState(''); const [categoryId, setCategoryId] = useState<string | null>(null);
  useEffect(() => { setName(feed?.title ?? category?.name ?? ''); setUrl(feed?.url ?? ''); setCategoryId(feed?.categoryId ?? null); }, [category?.id, feed?.id, params.dialog]);
  const close = (changed = false) => {
    router.setParams({ dialog: undefined, target: undefined });
    if (!changed) return;
    void queryClient.refetchQueries({ queryKey: ['library-tree'], type: 'active' });
    void queryClient.refetchQueries({ queryKey: ['articles', 'collection'], type: 'active' });
  };
  const action = useMutation({ mutationFn: async () => {
    if (params.dialog === 'new-category') return libraryRepo.createCategory(name);
    if (params.dialog === 'edit-category' && category) return libraryRepo.updateCategory(category.id, { name });
    if (params.dialog === 'add-feed') {
      if (isOpmlUrl(url)) return importFeedsFromOpmlUrl(url, tree.data?.categories.find((item: LibraryCategory) => item.id === categoryId)?.name ?? '');
      return addFeed({ title: name, url }, '', categoryId ?? undefined);
    }
    if (params.dialog === 'add-article') return articleRepo.add({ title: name, url });
    if (params.dialog === 'edit-feed' && feed) return libraryRepo.updateFeed(feed.id, { customTitle: name, categoryId, url: feed.editableUrl ? url : undefined });
    if (params.dialog === 'delete-category' && category) return libraryRepo.removeCategory(category.id);
    if (params.dialog === 'delete-feed' && feed) return libraryRepo.removeFeed(feed.id);
  }, onSuccess: () => close(true) });
  const visible = Boolean(params.dialog && ['new-category','edit-category','add-feed','add-article','edit-feed','delete-category','delete-feed'].includes(params.dialog));
  const deleting = params.dialog?.startsWith('delete-');
  const articleDialog = params.dialog === 'add-article';
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={() => close()}>
    <View style={[styles.backdrop, { backgroundColor: colors.scrim }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('close')} style={styles.dismissLayer} onPress={() => close()} />
      <View style={[styles.dialog, { backgroundColor: colors.card }]}>
        <Text style={[styles.title, { color: colors.text }]}>{deleting ? t('confirmDelete') : articleDialog ? t('addArticle') : params.dialog?.includes('category') ? t('category') : t('feed')}</Text>
        {deleting ? <Text style={{ color: colors.secondary }}>{params.dialog === 'delete-category' ? t('deleteCategoryMovesFeeds') : t('deleteFeedConfirm', { title: feed?.title ?? '' })}</Text> : <>
          <TextInput value={name} onChangeText={setName} placeholder={articleDialog ? t('articleTitleOptional') : params.dialog?.includes('category') ? t('category') : t('feedName')} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
          {params.dialog?.includes('feed') || articleDialog ? <TextInput value={url} onChangeText={setUrl} editable={!feed || feed.editableUrl} autoCapitalize="none" placeholder={articleDialog ? t('articleUrl') : t('rssUrl')} style={[styles.input, { color: colors.text, borderColor: colors.border }]} /> : null}
          {params.dialog?.includes('feed') ? <View style={styles.categories}><Pressable style={[styles.category, !categoryId && { backgroundColor: colors.selected }]} onPress={() => setCategoryId(null)}><Text style={{ color: colors.text }}>{t('uncategorized')}</Text></Pressable>{tree.data?.categories.map((item: LibraryCategory) => <Pressable key={item.id} style={[styles.category, categoryId === item.id && { backgroundColor: colors.selected }]} onPress={() => setCategoryId(item.id)}><Text style={{ color: categoryId === item.id ? colors.blue : colors.text }}>{item.name}</Text></Pressable>)}</View> : null}
        </>}
        {action.error ? <Text style={{ color: colors.destructive }}>{action.error instanceof Error ? action.error.message : t('updateFailed')}</Text> : null}
        <View style={styles.actions}>
          {params.dialog === 'edit-category' ? <Pressable onPress={() => router.setParams({ dialog: 'delete-category' })}><Text style={{ color: colors.destructive }}>{t('delete')}</Text></Pressable> : null}
          {params.dialog === 'edit-feed' ? <Pressable onPress={() => router.setParams({ dialog: 'delete-feed' })}><Text style={{ color: colors.destructive }}>{t('delete')}</Text></Pressable> : null}
          <View style={{ flex: 1 }} /><Pressable onPress={() => close()}><Text style={{ color: colors.secondary }}>{t('cancel')}</Text></Pressable>
          <Pressable disabled={action.isPending || (!deleting && params.dialog !== 'add-feed' && !articleDialog && !name.trim()) || ((params.dialog === 'add-feed' || articleDialog) && !url.trim())} onPress={() => action.mutate()}><Text style={{ color: colors.blue }}>{action.isPending ? t('saving') : deleting ? t('delete') : t('save')}</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}
const styles = StyleSheet.create({ backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.section }, dismissLayer: { ...StyleSheet.absoluteFillObject }, dialog: { width: 520, maxHeight: '80%', borderRadius: radius.panel, padding: spacing.xxl, gap: spacing.lg }, title: { fontSize: 20, fontWeight: '700' }, input: { minHeight: 44, borderWidth: 1, borderRadius: radius.control, paddingHorizontal: spacing.lg }, categories: { maxHeight: 180, flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }, category: { minHeight: 34, paddingHorizontal: spacing.md, borderRadius: radius.round, justifyContent: 'center' }, actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxl, marginTop: spacing.lg } });
