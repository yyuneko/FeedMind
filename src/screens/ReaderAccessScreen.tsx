import { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readerCredentialRepo } from '@/api/repositories';
import type { ReaderCredential } from '@/types';
import { AutofillSafeTextInput as TextInput } from '@/components/AutofillSafeTextInput';
import { radius, spacing, typography, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

const endpoint = 'https://reader.feedmind.cc/api/greader.php';

export function ReaderAccessScreen() {
  const colors = useThemeColors(); const queryClient = useQueryClient();
  const [open, setOpen] = useState(false); const [name, setName] = useState('我的阅读器');
  const credentials = useQuery({ queryKey: ['reader-credentials'], queryFn: readerCredentialRepo.list });
  const create = useMutation({ mutationFn: readerCredentialRepo.create, onSuccess: async (credential) => {
    setOpen(false); setName('我的阅读器'); await queryClient.invalidateQueries({ queryKey: ['reader-credentials'] });
    Alert.alert('应用密码已创建', `登录名：${credential.loginName}\n应用密码：${credential.appPassword}\n\n密码只显示这一次，请立即复制。`, [
      { text: '复制密码', onPress: () => { void Clipboard.setStringAsync(credential.appPassword); } }, { text: '完成' },
    ]);
  }, onError: (error) => Alert.alert('创建失败', error instanceof Error ? error.message : '请稍后重试') });
  const remove = useMutation({ mutationFn: readerCredentialRepo.remove, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reader-credentials'] }) });
  return <SafeAreaView style={[screenStyles.safe, { backgroundColor: colors.background }]} edges={['top']}>
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <Pressable style={styles.action} onPress={() => router.back()}><Ionicons name="chevron-back" size={24} color={colors.text} /></Pressable>
      <Text style={[styles.title, { color: colors.text }]}>第三方阅读器接入</Text>
      <Pressable style={styles.action} onPress={() => setOpen(true)}><Ionicons name="add" size={24} color={colors.blue} /></Pressable>
    </View>
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[styles.label, { color: colors.secondary }]}>Google Reader API 地址</Text>
      <Pressable onPress={() => void Clipboard.setStringAsync(endpoint)}><Text selectable style={[styles.value, { color: colors.blue }]}>{endpoint}</Text></Pressable>
      <Text style={[styles.label, { color: colors.secondary }]}>登录名</Text>
      <Text selectable style={[styles.value, { color: colors.text }]}>{credentials.data?.loginName || '需要已验证的账户邮箱'}</Text>
      <Text style={[styles.note, { color: colors.secondary }]}>第三方阅读器始终访问“当前系统”的订阅和原始解析正文，不会代理当前选中的外部数据源。</Text>
      <Text style={[styles.section, { color: colors.text }]}>应用密码</Text>
      {(credentials.data?.items ?? []).map((credential: ReaderCredential) => <View key={credential.id} style={[styles.row, { borderBottomColor: colors.border }]}>
        <View style={styles.grow}><Text style={{ color: colors.text, fontWeight: '600' }}>{credential.name}</Text>
          <Text style={{ color: colors.secondary, fontSize: 12 }}>{credential.lastUsedAt ? `最后使用：${new Date(credential.lastUsedAt).toLocaleString()}` : '尚未使用'}</Text></View>
        <Pressable onPress={() => Alert.alert('撤销应用密码？', '已登录的第三方阅读器也会立即退出。', [
          { text: '取消', style: 'cancel' }, { text: '撤销', style: 'destructive', onPress: () => remove.mutate(credential.id) },
        ])}><Ionicons name="trash-outline" size={20} color={colors.destructive} /></Pressable>
      </View>)}
    </ScrollView>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}><View style={[styles.backdrop, { backgroundColor: colors.scrim }]}><View style={[styles.dialog, { backgroundColor: colors.card }]}>
      <Text style={[styles.title, { color: colors.text }]}>创建应用密码</Text>
      <TextInput value={name} onChangeText={setName} placeholder="设备或阅读器名称" placeholderTextColor={colors.subtle} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
      <View style={styles.buttons}><Pressable onPress={() => setOpen(false)}><Text style={{ color: colors.secondary }}>取消</Text></Pressable>
        <Pressable disabled={!name.trim() || create.isPending} onPress={() => create.mutate(name.trim())}><Text style={{ color: colors.blue }}>{create.isPending ? '创建中…' : '创建'}</Text></Pressable></View>
    </View></View></Modal>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  header: { minHeight: 56, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth },
  action: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, title: { fontSize: 20, fontWeight: '700' },
  content: { padding: spacing.xl, maxWidth: 720, width: '100%', alignSelf: 'center' }, label: { ...typography.metadata, marginTop: spacing.lg }, value: { ...typography.body, marginTop: spacing.xs },
  note: { ...typography.metadata, marginTop: spacing.xl, lineHeight: 20 }, section: { ...typography.body, fontWeight: '700', marginTop: spacing.section },
  row: { minHeight: 62, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth }, grow: { flex: 1, gap: 4 },
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl }, dialog: { width: '100%', maxWidth: 480, padding: spacing.xxl, borderRadius: radius.panel, gap: spacing.lg },
  input: { borderWidth: 1, borderRadius: radius.control, minHeight: 46, paddingHorizontal: spacing.lg }, buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.xxl },
});
