import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { libraryRepo } from '@/api/repositories';
import { QueryState } from '@/components/QueryState';
import { SourceSelector } from '@/components/SourceSelector';
import { t } from '@/i18n';
import type { LibraryCategory } from '@/types';
import { radius, spacing, typography, useThemeColors } from '@/utils/theme';

export function SubscriptionsScreen() {
  const colors = useThemeColors();
  const tree = useQuery({ queryKey: ['library-tree'], queryFn: libraryRepo.tree, staleTime: Infinity });
  if (tree.isLoading) return <QueryState title={t('feedLoading')} loading />;
  if (tree.isError) return <QueryState title={t('feedLoadFailed')} actionLabel={t('retry')} onAction={() => void tree.refetch()} />;
  const categoryCount = tree.data?.categories.length ?? 0;
  const feedCount = (tree.data?.categories.reduce((sum: number, item: LibraryCategory) => sum + item.feeds.length, 0) ?? 0) + (tree.data?.uncategorized.feeds.length ?? 0);
  return <View style={[styles.page, { backgroundColor: colors.page }]}><SourceSelector /><View style={styles.content}>
    <Text style={[styles.title, { color: colors.text }]}>{t('feeds')}</Text>
    <Text style={[styles.description, { color: colors.secondary }]}>{categoryCount} {t('categories')} · {feedCount} {t('feeds')}</Text>
    <View style={styles.cards}>
      <ActionCard icon="add-circle-outline" title={t('addFeed')} onPress={() => router.push({ pathname: '/subscriptions', params: { dialog: 'add-feed' } })} />
      <ActionCard icon="document-text-outline" title={t('addArticle')} onPress={() => router.push({ pathname: '/subscriptions', params: { dialog: 'add-article' } })} />
      <ActionCard icon="folder-outline" title={t('newCategory')} onPress={() => router.push({ pathname: '/subscriptions', params: { dialog: 'new-category' } })} />
      <ActionCard icon="cloud-outline" title={t('sync')} onPress={() => router.push('/settings/sources')} />
    </View>
  </View></View>;
}

function ActionCard({ icon, title, onPress }: { icon: keyof typeof Ionicons.glyphMap; title: string; onPress: () => void }) {
  const colors = useThemeColors();
  return <Pressable style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={onPress}>
    <Ionicons name={icon} size={26} color={colors.blue} /><Text style={[styles.cardTitle, { color: colors.text }]}>{title}</Text>
  </Pressable>;
}
const styles = StyleSheet.create({ page: { flex: 1 }, content: { width: '100%', maxWidth: 820, alignSelf: 'center', padding: 40 }, title: { ...typography.navigationTitle, fontSize: 28 }, description: { marginTop: spacing.sm, fontSize: 14 }, cards: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, marginTop: spacing.section }, card: { width: 200, minHeight: 128, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.panel, padding: spacing.xxl, justifyContent: 'space-between' }, cardTitle: { fontSize: 15, fontWeight: '600' } });
