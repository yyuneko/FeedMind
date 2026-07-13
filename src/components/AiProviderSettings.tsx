import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { AutofillSafeTextInput as TextInput } from '@/components/AutofillSafeTextInput';
import { credentialStore } from '@/ai/credentialStore';
import { AI_PROVIDERS, AI_PROVIDER_IDS, DEFAULT_AI_PROVIDER_ID, aiSettingKey, isAiProviderId } from '@/ai/providers/config';
import type { AiProviderId } from '@/ai/providers/types';
import { settingsRepo } from '@/db/repositories';
import { aiComponentText as t } from '@/ai/componentI18n';
import { getAiLabels } from '@/ai/labels';
import { useThemeColors } from '@/utils/theme';
import { Ionicons } from '@expo/vector-icons';

export function AiProviderSettings() {
  const [providerId, setProviderId] = useState<AiProviderId>(DEFAULT_AI_PROVIDER_ID);
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const provider = AI_PROVIDERS[providerId];
  const aiLabels = getAiLabels();

  useEffect(() => {
    let active = true;
    settingsRepo.get(aiSettingKey.provider).then((value) => {
      if (active && isAiProviderId(value)) setProviderId(value);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      credentialStore.get(providerId),
      settingsRepo.get(aiSettingKey.endpoint(providerId)),
      settingsRepo.get(aiSettingKey.model(providerId)),
    ]).then(([nextApiKey, nextEndpoint, nextModel]) => {
      if (!active) return;
      setApiKey(nextApiKey ?? '');
      setEndpoint(nextEndpoint || provider.defaultEndpoint);
      setModel(nextModel || provider.defaultModel);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [provider.defaultEndpoint, provider.defaultModel, providerId]);

  const selectProvider = (next: AiProviderId) => {
    setProviderId(next);
    settingsRepo.set(aiSettingKey.provider, next).catch(() => undefined);
  };
  const updateApiKey = (next: string) => {
    setApiKey(next);
    (next ? credentialStore.set(providerId, next) : credentialStore.remove(providerId)).catch(() => undefined);
  };
  const updateEndpoint = (next: string) => {
    setEndpoint(next);
    settingsRepo.set(aiSettingKey.endpoint(providerId), next.trim() || provider.defaultEndpoint).catch(() => undefined);
  };
  const updateModel = (next: string) => {
    setModel(next);
    settingsRepo.set(aiSettingKey.model(providerId), next.trim() || provider.defaultModel).catch(() => undefined);
  };

  return (
    <>
      <ChoiceRow label={aiLabels.provider} value={providerId} options={AI_PROVIDER_IDS.map((id) => ({ label: AI_PROVIDERS[id].name, value: id }))} onChange={selectProvider} />
      <InputRow label={aiLabels.apiKey} value={apiKey} onChangeText={updateApiKey} placeholder={t('apiKeyPlaceholder')} secure />
      <InputRow label={aiLabels.endpoint} value={endpoint} onChangeText={updateEndpoint} placeholder={provider.defaultEndpoint} />
      <ModelRow providerId={providerId} value={model} onChange={updateModel} />
    </>
  );
}

type Choice<T extends string> = { label: string; value: T };

function ChoiceRow<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Choice<T>[]; onChange: (value: T) => void }) {
  const theme = useThemeColors();
  const [open, setOpen] = useState(false);
  const current = options.find((item) => item.value === value)?.label ?? value;
  return (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      <Pressable style={[styles.select, { backgroundColor: theme.page }]} onPress={() => setOpen(true)}>
        <Text numberOfLines={1} style={[styles.selectText, { color: theme.text }]}>{current}</Text>
        <Ionicons name='chevron-down' style={{ color: theme.secondary }} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={[styles.menu, { backgroundColor: theme.card, borderColor: theme.border }]}>
            {options.map((item) => <Pressable key={item.value} style={[styles.menuItem, { borderBottomColor: theme.border }]} onPress={() => { onChange(item.value); setOpen(false); }}><Text style={[styles.menuText, { color: item.value === value ? theme.blue : theme.text }]}>{item.label}</Text></Pressable>)}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function ModelRow({ providerId, value, onChange }: { providerId: AiProviderId; value: string; onChange: (value: string) => void }) {
  const theme = useThemeColors();
  const provider = AI_PROVIDERS[providerId];
  const aiLabels = getAiLabels();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const chooseCustom = () => { const next = custom.trim(); if (next) { onChange(next); setOpen(false); } };
  return (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      <Text style={[styles.label, { color: theme.text }]}>{aiLabels.model}</Text>
      <Pressable style={[styles.select, { backgroundColor: theme.page }]} onPress={() => { setCustom(provider.models.includes(value) ? '' : value); setOpen(true); }}>
        <Text numberOfLines={1} style={[styles.selectText, { color: theme.text }]}>{value || provider.defaultModel}</Text><Ionicons name='chevron-down' style={{ color: theme.secondary }} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={[styles.menu, { backgroundColor: theme.card, borderColor: theme.border }]} onPress={() => undefined}>
            {provider.models.map((item) => <Pressable key={item} style={[styles.menuItem, { borderBottomColor: theme.border }]} onPress={() => { onChange(item); setOpen(false); }}><Text style={[styles.menuText, { color: item === value ? theme.blue : theme.text }]}>{item}</Text></Pressable>)}
            <TextInput value={custom} onChangeText={setCustom} onSubmitEditing={chooseCustom} placeholder={t('customModel')} placeholderTextColor={theme.subtle} autoCapitalize="none" autoCorrect={false} style={[styles.customInput, { color: theme.text, borderColor: theme.border, backgroundColor: theme.page }]} />
            <Pressable disabled={!custom.trim()} style={styles.confirm} onPress={chooseCustom}><Text style={[styles.confirmText, { color: custom.trim() ? theme.blue : theme.subtle }]}>{t('confirm')}</Text></Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function InputRow({ label, value, onChangeText, placeholder, secure }: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; secure?: boolean }) {
  const theme = useThemeColors();
  return <View style={[styles.row, { borderBottomColor: theme.border }]}><Text style={[styles.label, { color: theme.text }]}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={theme.subtle} secureTextEntry={secure} autoCapitalize="none" autoCorrect={false} style={[styles.input, { color: theme.secondary }]} /></View>;
}

const styles = StyleSheet.create({
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  label: { width: 112, fontSize: 13, fontWeight: '500' },
  input: { flex: 1, textAlign: 'right', fontSize: 12 },
  select: { flex: 1, minWidth: 132, height: 32, borderRadius: 8, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  selectText: { flex: 1, textAlign: 'right', fontSize: 12, fontWeight: '700' },
  backdrop: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, backgroundColor: 'rgba(0, 0, 0, 0.18)' },
  menu: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', paddingBottom: 10 },
  menuItem: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  menuText: { fontSize: 14, fontWeight: '700' },
  customInput: { height: 42, margin: 12, marginBottom: 4, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, fontSize: 13 },
  confirm: { height: 38, alignItems: 'center', justifyContent: 'center' },
  confirmText: { fontSize: 14, fontWeight: '700' },
});
