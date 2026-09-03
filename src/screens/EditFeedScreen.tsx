import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { AutofillSafeTextInput as TextInput } from '@/components/AutofillSafeTextInput';
import { QueryState } from '@/components/QueryState';
import { libraryRepo } from '@/api/repositories';
import type { LibraryCategory, LibraryFeed } from '@/types';
import { t } from '@/i18n';
import { radius, spacing, typography, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

export function EditFeedScreen() {
  const params = useLocalSearchParams<{ id?: string; sourceId?: string }>();
  const sourceId = params.sourceId ?? params.id ?? '';
  const colors = useThemeColors(); const client = useQueryClient();
  const tree = useQuery({ queryKey: ['library-tree'], queryFn: libraryRepo.tree, staleTime: Infinity });
  const feeds = useMemo(() => ([...(tree.data?.categories.flatMap((item: LibraryCategory) => item.feeds) ?? []), ...(tree.data?.uncategorized.feeds ?? [])] as LibraryFeed[]), [tree.data]);
  const feed = feeds.find((item) => item.id === sourceId || item.subscriptionId === sourceId);
  const [title, setTitle] = useState(''); const [url, setUrl] = useState(''); const [categoryId, setCategoryId] = useState<string | null>(null); const [categoryOpen, setCategoryOpen] = useState(false);
  useEffect(() => { if (!feed) return; setTitle(feed.title); setUrl(feed.url ?? ''); setCategoryId(feed.categoryId); }, [feed]);
  const refresh = () => client.refetchQueries({ queryKey: ['library-tree'], type: 'active' });
  const save = useMutation({ mutationFn: () => libraryRepo.updateFeed(feed!.id, { customTitle: title, categoryId, url: feed!.editableUrl ? url : undefined }), onSuccess: async () => { await refresh(); router.back(); }, onError: (error) => Alert.alert(t('updateFailed'), error instanceof Error ? error.message : t('soonRetry')) });
  const remove = () => feed && Alert.alert(t('confirmDelete'), t('deleteFeedConfirm', { title: feed.title }), [{ text: t('cancel'), style: 'cancel' }, { text: t('delete'), style: 'destructive', onPress: () => void libraryRepo.removeFeed(feed.id).then(async () => { await refresh(); router.back(); }) }]);
  const categoryName = categoryId ? tree.data?.categories.find((item: LibraryCategory) => item.id === categoryId)?.name : t('uncategorized');
  if (tree.isLoading) return <SafeAreaView style={[screenStyles.safe, { backgroundColor: colors.background }]}><QueryState title={t('feedLoading')} loading /></SafeAreaView>;
  if (!feed) return <SafeAreaView style={[screenStyles.safe, { backgroundColor: colors.background }]}><QueryState title={t('feedLoadFailed')} /></SafeAreaView>;
  return <SafeAreaView style={[screenStyles.safe, { backgroundColor: colors.background }]}>
    <View style={screenStyles.header}><Pressable onPress={() => router.back()}><Text style={[screenStyles.link, { color: colors.blue }]}>{t('cancel')}</Text></Pressable><Text style={[screenStyles.navTitle, { color: colors.text }]}>{t('editFeed')}</Text><Pressable disabled={!title.trim() || (feed.editableUrl && !url.trim()) || save.isPending} onPress={() => save.mutate()}><Text style={[screenStyles.link, { color: colors.blue }]}>{save.isPending ? t('saving') : t('save')}</Text></Pressable></View>
    <ScrollView contentContainerStyle={screenStyles.content}><Text style={[styles.label, { color: colors.secondary }]}>{t('feedName')}</Text><TextInput value={title} onChangeText={setTitle} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
      <Text style={[styles.label, { color: colors.secondary }]}>{t('rssUrl')}</Text><TextInput value={url} onChangeText={setUrl} editable={feed.editableUrl} autoCapitalize="none" style={[styles.input, !feed.editableUrl && styles.readOnly, { color: colors.text, borderColor: colors.border }]} />
      <Text style={[styles.label, { color: colors.secondary }]}>{t('category')}</Text><Pressable style={[styles.selector, { borderColor: colors.border }]} onPress={() => setCategoryOpen(true)}><Text style={{ color: colors.text }}>{categoryName}</Text><Text style={{ color: colors.secondary }}>›</Text></Pressable>
      <Pressable style={styles.deleteButton} onPress={remove}><Text style={{ color: colors.destructive }}>{t('deleteFeed')}</Text></Pressable>
    </ScrollView>
    <Modal visible={categoryOpen} transparent animationType="slide" onRequestClose={() => setCategoryOpen(false)}><Pressable style={[styles.backdrop, { backgroundColor: colors.scrim }]} onPress={() => setCategoryOpen(false)}><View style={[styles.sheet, { backgroundColor: colors.card }]} onStartShouldSetResponder={() => true}><Text style={[styles.sheetTitle, { color: colors.text }]}>{t('category')}</Text>
      <CategoryChoice name={t('uncategorized')} selected={!categoryId} onPress={() => { setCategoryId(null); setCategoryOpen(false); }} />{tree.data?.categories.map((item: LibraryCategory) => <CategoryChoice key={item.id} name={item.name} selected={categoryId === item.id} onPress={() => { setCategoryId(item.id); setCategoryOpen(false); }} />)}
    </View></Pressable></Modal>
  </SafeAreaView>;
}

function CategoryChoice({ name, selected, onPress }: { name: string; selected: boolean; onPress: () => void }) { const colors = useThemeColors(); return <Pressable style={styles.choice} onPress={onPress}><Text style={{ color: selected ? colors.blue : colors.text }}>{name}</Text><Text style={{ color: colors.blue }}>{selected ? '✓' : ''}</Text></Pressable>; }
const styles = StyleSheet.create({ label: { ...typography.metadata, fontWeight: '600', marginTop: spacing.xl, marginBottom: spacing.md }, input: { height: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.control, paddingHorizontal: spacing.lg }, readOnly: { opacity: 0.6 }, selector: { height: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.control, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, deleteButton: { alignSelf: 'center', marginTop: spacing.section, padding: spacing.lg }, backdrop: { flex: 1, justifyContent: 'flex-end' }, sheet: { maxHeight: '70%', padding: spacing.xxl, paddingBottom: 36, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet }, sheetTitle: { fontSize: 20, fontWeight: '700', marginBottom: spacing.lg }, choice: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } });
