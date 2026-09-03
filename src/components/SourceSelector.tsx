import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { connectionRepo, sourceSelectionRepo } from '@/api/repositories';
import type { SourceConnection } from '@/types';
import { radius, spacing, useThemeColors } from '@/utils/theme';
import { t } from '@/i18n';

export function SourceSelector() {
  const colors = useThemeColors(); const client = useQueryClient();
  const connections = useQuery({ queryKey: ['connections'], queryFn: connectionRepo.list });
  const selection = useQuery({ queryKey: ['source-selection'], queryFn: sourceSelectionRepo.get,
    refetchInterval: (query) => ['pending', 'running'].includes(query.state.data?.job?.status ?? '') ? 2000 : false });
  const choose = useMutation({
    mutationFn: ({ connectionId, migrate }: { connectionId: string; migrate: boolean }) => sourceSelectionRepo.select(connectionId, migrate),
    onSuccess: async () => { await client.invalidateQueries(); },
    onError: (error) => Alert.alert('切换失败', error instanceof Error ? error.message : t('soonRetry')),
  });
  const select = (connection: SourceConnection) => {
    if (connection.id === selection.data?.connection?.id || choose.isPending) return;
    if (connection.type === 'direct_rss') { choose.mutate({ connectionId: connection.id, migrate: false }); return; }
    Alert.alert(`切换到 ${connection.name}`, '是否把当前来源的订阅、分类、已读和收藏状态同步到该来源？', [
      { text: t('cancel'), style: 'cancel' },
      { text: '仅切换', onPress: () => choose.mutate({ connectionId: connection.id, migrate: false }) },
      { text: '切换并同步', onPress: () => choose.mutate({ connectionId: connection.id, migrate: true }) },
    ]);
  };
  const job = selection.data?.job;
  return <View style={styles.container}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.choices}>
      {(connections.data ?? []).map((connection: SourceConnection) => {
        const active = connection.id === selection.data?.connection?.id;
        return <Pressable key={connection.id} accessibilityRole="button" accessibilityState={{ selected: active, busy: choose.isPending }}
          style={[styles.choice, { borderColor: active ? colors.blue : colors.border, backgroundColor: active ? colors.pill : colors.card }]}
          onPress={() => select(connection)}>
          <Ionicons name={connection.type === 'direct_rss' ? 'cloud-outline' : 'git-network-outline'} size={15} color={active ? colors.blue : colors.secondary} />
          <Text numberOfLines={1} style={{ color: active ? colors.blue : colors.secondary, fontWeight: active ? '700' : '500' }}>
            {connection.type === 'direct_rss' ? '当前系统' : connection.name}
          </Text>
        </Pressable>;
      })}
    </ScrollView>
    {job && ['pending', 'running', 'partial', 'failed'].includes(job.status) ? <View style={[styles.status, { backgroundColor: colors.pill }] }>
      <Text style={[styles.statusText, { color: colors.secondary }]}>迁移 {job.succeededCount}/{job.totalCount} · 失败 {job.failedCount} · 跳过 {job.skippedCount}</Text>
      {job.failedCount > 0 || job.status === 'failed' ? <Pressable onPress={() => sourceSelectionRepo.retry(job.id).then(() => client.invalidateQueries({ queryKey: ['source-selection'] }))}>
        <Text style={{ color: colors.blue }}>重试失败项</Text>
      </Pressable> : null}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm }, choices: { gap: spacing.sm, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm },
  choice: { height: 34, maxWidth: 220, paddingHorizontal: spacing.lg, borderWidth: 1, borderRadius: radius.round, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  status: { marginHorizontal: spacing.xl, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.control, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  statusText: { flex: 1, fontSize: 12 },
});
