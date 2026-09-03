import { useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AutofillSafeTextInput as TextInput } from '@/components/AutofillSafeTextInput';
import { connectionRepo, sourceRepo, sourceSelectionRepo } from '@/api/repositories';
import type { Source, SourceConnection } from '@/types';
import { useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';
import { radius, spacing, typography } from '@/utils/theme';

export function SourceConnectionsScreen() {
  const colors = useThemeColors(); const queryClient = useQueryClient();
  const desktop = useDesktopLayout();
  const [visible, setVisible] = useState(false); const [name, setName] = useState('FreshRSS');
  const [baseUrl, setBaseUrl] = useState(''); const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  const connections = useQuery({ queryKey: ['connections'], queryFn: connectionRepo.list });
  const selection = useQuery({ queryKey: ['source-selection'], queryFn: sourceSelectionRepo.get });
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => sourceRepo.list() });
  const selectConnection = useMutation({
    mutationFn: ({ connectionId, migrate }: { connectionId: string; migrate: boolean }) => sourceSelectionRepo.select(connectionId, migrate),
    onSuccess: () => void queryClient.invalidateQueries(),
    onError: (error) => Alert.alert('切换失败', error instanceof Error ? error.message : '请稍后重试'),
  });
  const chooseConnection = (connection: SourceConnection) => {
    if (connection.id === selection.data?.connection?.id || selectConnection.isPending) return;
    if (connection.type === 'direct_rss') {
      selectConnection.mutate({ connectionId: connection.id, migrate: false });
      return;
    }
    Alert.alert(`切换到 ${connection.name}`, '是否把当前来源的订阅、分类、已读和收藏状态同步到该来源？', [
      { text: '取消', style: 'cancel' },
      { text: '仅切换', onPress: () => selectConnection.mutate({ connectionId: connection.id, migrate: false }) },
      { text: '切换并同步', onPress: () => selectConnection.mutate({ connectionId: connection.id, migrate: true }) },
    ]);
  };
  const create = useMutation({ mutationFn: connectionRepo.create, onSuccess: (connection) => {
    setVisible(false); setBaseUrl(''); setUsername(''); setPassword(''); void queryClient.invalidateQueries();
    Alert.alert('连接已保存', '是否立即切换到这个外部源？', [
      { text: '稍后', style: 'cancel' },
      { text: '仅切换', onPress: () => void sourceSelectionRepo.select(connection.id, false).then(() => queryClient.invalidateQueries()) },
      { text: '切换并同步', onPress: () => void sourceSelectionRepo.select(connection.id, true).then(() => queryClient.invalidateQueries()) },
    ]);
  }, onError: (error) => Alert.alert('连接失败', error instanceof Error ? error.message : '请检查 FreshRSS API 配置') });
  const sync = useMutation({ mutationFn: connectionRepo.sync, onSuccess: () => void queryClient.invalidateQueries(),
    onError: (error) => Alert.alert('同步失败', error instanceof Error ? error.message : '请稍后重试') });
  const remove = useMutation({ mutationFn: connectionRepo.remove, onSuccess: () => void queryClient.invalidateQueries(),
    onError: (error) => Alert.alert('删除失败', error instanceof Error ? error.message : '请稍后重试') });
  const count = (connection: SourceConnection) => (sources.data ?? []).filter((source: Source) => source.connectionId === connection.id).length;
  return <SafeAreaView style={[screenStyles.safe, { backgroundColor: colors.background }]} edges={['top']}>
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回" style={styles.headerAction} onPress={() => router.back()}><Ionicons name='chevron-back' size={24} color={colors.text} /></Pressable>
      <Text style={[styles.title, { color: colors.text }]}>数据源连接</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="添加数据源连接" style={styles.headerAction} onPress={() => setVisible(true)}><Ionicons name='add-outline' size={24} color={colors.blue} /></Pressable>
    </View>
    <FlatList data={connections.data ?? []} keyExtractor={(item) => item.id} contentContainerStyle={[styles.list, desktop && styles.desktopList]}
      ListEmptyComponent={<Text style={{ color: colors.secondary }}>尚未添加外部聚合器。直接 RSS 仍可在订阅页添加。</Text>}
      renderItem={({ item }) => {
        const active = item.id === selection.data?.connection?.id || (!selection.data && item.isActive === true);
        return <View style={[styles.card, { borderBottomColor: colors.border }]}>
        <View style={styles.row}><View style={styles.grow}><View style={styles.connectionTitleRow}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>{item.name}</Text>
          {active ? <View style={[styles.activeBadge, { backgroundColor: colors.pill }]}>
            <Ionicons name="checkmark-circle" size={14} color={colors.blue} />
            <Text style={[styles.activeBadgeText, { color: colors.blue }]}>当前使用</Text>
          </View> : null}
        </View>
          <Text style={{ color: colors.secondary }}>{item.type === 'google_reader' ? 'Google Reader API' : 'Direct RSS'} · {count(item)} 个来源</Text>
          <Text style={{ color: item.status === 'error' ? colors.destructive : colors.secondary }}>{item.status}{item.lastErrorCode ? ` · ${item.lastErrorCode}` : ''}</Text></View>
          {!active ? <Pressable accessibilityRole="button" accessibilityLabel={`切换到 ${item.name}`}
            disabled={selectConnection.isPending} style={[styles.switchAction, { borderColor: colors.blue }]}
            onPress={() => chooseConnection(item)}>
            <Text style={[styles.switchActionText, { color: colors.blue }]}>{selectConnection.isPending ? '切换中…' : '切换使用'}</Text>
          </Pressable> : null}
          {item.type !== 'direct_rss' ? <><Pressable accessibilityRole="button" accessibilityLabel="同步连接" style={styles.action} onPress={() => sync.mutate(item.id)}><Ionicons name='sync' size={20} color={colors.blue} /></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="删除连接" style={styles.action} onPress={() => Alert.alert('删除连接？', '来源关系会被移除，已解析文章仍保留。', [
              { text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => remove.mutate(item.id) }])}><Ionicons name='trash-outline' size={20} color={colors.destructive} /></Pressable></> : null}
        </View>
        {(sources.data ?? []).filter((source: Source) => source.connectionId === item.id).map((source: Source) =>
          <View key={source.id} style={[styles.source, { borderTopColor: colors.border }]}>
            <Ionicons name='reader-outline' size={20} color={source.enabled ? colors.blue : colors.subtle} />
            <View style={styles.grow}><Text numberOfLines={1} style={{ color: colors.text }}>{source.title}</Text>
              <Text numberOfLines={1} style={{ color: colors.secondary, fontSize: 12 }}>{source.categories.join(' · ') || source.url}</Text></View>
            <Text style={{ color: colors.secondary }}>{source.articleCount}</Text>
          </View>)}
      </View>;
      }} />
    <Modal visible={visible} transparent animationType={desktop ? 'fade' : 'slide'} onRequestClose={() => setVisible(false)}><View style={[styles.backdrop, !desktop && styles.sheetBackdrop, { backgroundColor: colors.scrim }]}><View style={[styles.dialog, !desktop && styles.sheetDialog, { backgroundColor: colors.card }]}>
      <Text style={[styles.title, { color: colors.text }]}>连接 FreshRSS</Text>
      <TextInput value={name} onChangeText={setName} placeholder='连接名称' placeholderTextColor={colors.subtle} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
      <TextInput value={baseUrl} onChangeText={setBaseUrl} autoCapitalize='none' placeholder='https://rss.example.com/api/greader.php' placeholderTextColor={colors.subtle} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
      <TextInput value={username} onChangeText={setUsername} autoCapitalize='none' placeholder='API 用户名' placeholderTextColor={colors.subtle} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
      <TextInput value={password} onChangeText={setPassword} secureTextEntry placeholder='专用 API 密码' placeholderTextColor={colors.subtle} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
      <View style={styles.buttons}><Pressable onPress={() => setVisible(false)}><Text style={{ color: colors.secondary }}>取消</Text></Pressable>
        <Pressable disabled={!name.trim() || !baseUrl.trim() || !username.trim() || !password} onPress={() => create.mutate({ name, baseUrl, username, password })}><Text style={{ color: colors.blue }}>{create.isPending ? '连接中…' : '连接并同步'}</Text></Pressable></View>
    </View></View></Modal>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  header: { minHeight: 56, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth }, headerAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '700' }, list: { padding: spacing.xl }, desktopList: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingVertical: spacing.section }, card: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: spacing.xl },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md }, grow: { flex: 1, gap: 3 }, cardTitle: { ...typography.body, fontWeight: '600' }, action: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  connectionTitleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  activeBadge: { minHeight: 24, paddingHorizontal: spacing.sm, borderRadius: radius.round, flexDirection: 'row', alignItems: 'center', gap: 4 },
  activeBadgeText: { fontSize: 12, fontWeight: '700' },
  switchAction: { minHeight: 36, paddingHorizontal: spacing.md, borderWidth: 1, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
  switchActionText: { fontSize: 13, fontWeight: '600' },
  source: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 10, paddingTop: 10, flexDirection: 'row', alignItems: 'center', gap: 9 },
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl }, sheetBackdrop: { justifyContent: 'flex-end', padding: 0 },
  dialog: { width: '100%', maxWidth: 520, borderRadius: radius.panel, padding: spacing.xxl, gap: spacing.lg }, sheetDialog: { maxWidth: undefined, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingBottom: spacing.section },
  input: { borderWidth: 1, borderRadius: radius.control, paddingHorizontal: spacing.lg, minHeight: 46 }, buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.xxxl, paddingTop: spacing.md },
});
