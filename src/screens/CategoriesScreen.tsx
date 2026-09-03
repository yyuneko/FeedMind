import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AutofillSafeTextInput as TextInput } from '@/components/AutofillSafeTextInput';
import { IconButton } from '@/components/IconButton';
import { libraryRepo } from '@/api/repositories';
import type { LibraryCategory } from '@/types';
import { t } from '@/i18n';
import { radius, spacing, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

export function CategoriesScreen() {
  const colors = useThemeColors(); const client = useQueryClient();
  const tree = useQuery({ queryKey: ['library-tree'], queryFn: libraryRepo.tree, staleTime: Infinity });
  const [editing, setEditing] = useState<LibraryCategory | 'new' | null>(null); const [name, setName] = useState('');
  const refresh = () => client.refetchQueries({ queryKey: ['library-tree'], type: 'active' });
  const save = useMutation({ mutationFn: () => editing === 'new' ? libraryRepo.createCategory(name) : libraryRepo.updateCategory(editing!.id, { name }), onSuccess: async () => { setEditing(null); await refresh(); } });
  const remove = (item: LibraryCategory) => Alert.alert(t('confirmDelete'), t('deleteCategoryMovesFeeds'), [{ text: t('cancel'), style: 'cancel' }, { text: t('delete'), style: 'destructive', onPress: () => void libraryRepo.removeCategory(item.id).then(refresh) }]);
  return <SafeAreaView style={[screenStyles.safe, { backgroundColor: colors.background }]}><View style={screenStyles.header}><IconButton name="chevron-back" label={t('back')} onPress={() => router.back()} /><Text style={[screenStyles.title, { color: colors.text }]}>{t('categories')}</Text><IconButton name="add" label={t('newCategory')} onPress={() => { setName(''); setEditing('new'); }} /></View>
    <FlatList data={tree.data?.categories as LibraryCategory[] | undefined} keyExtractor={(item) => item.id} renderItem={({ item }) => <View style={[styles.row, { borderBottomColor: colors.border }]}><Pressable style={{ flex: 1 }} onPress={() => router.push(`/category/${item.id}` as never)}><Text style={{ color: colors.text, fontWeight: '600' }}>{item.name}</Text><Text style={{ color: colors.secondary }}>{item.feeds.length} {t('feeds')}</Text></Pressable><IconButton name="create-outline" label={t('edit')} onPress={() => { setName(item.name); setEditing(item); }} /><IconButton name="trash-outline" label={t('delete')} onPress={() => remove(item)} /></View>} />
    <Modal visible={Boolean(editing)} transparent animationType="fade" onRequestClose={() => setEditing(null)}><Pressable style={[styles.backdrop, { backgroundColor: colors.scrim }]} onPress={() => setEditing(null)}><View style={[styles.dialog, { backgroundColor: colors.card }]} onStartShouldSetResponder={() => true}><TextInput autoFocus value={name} onChangeText={setName} placeholder={t('category')} style={[styles.input, { color: colors.text, borderColor: colors.border }]} /><View style={styles.actions}><Pressable onPress={() => setEditing(null)}><Text style={{ color: colors.secondary }}>{t('cancel')}</Text></Pressable><Pressable disabled={!name.trim() || save.isPending} onPress={() => save.mutate()}><Text style={{ color: colors.blue }}>{t('save')}</Text></Pressable></View></View></Pressable></Modal>
  </SafeAreaView>;
}
const styles = StyleSheet.create({ row: { minHeight: 62, paddingHorizontal: spacing.xl, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth }, backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl }, dialog: { width: '100%', borderRadius: radius.panel, padding: spacing.xxl, gap: spacing.xl }, input: { height: 46, borderWidth: 1, borderRadius: radius.control, paddingHorizontal: spacing.lg }, actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.xxl } });
