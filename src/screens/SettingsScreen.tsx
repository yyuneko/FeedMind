import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SettingRow } from '@/components/SettingRow';
import { promptRepo, settingsRepo } from '@/db/repositories';
import { syncNow } from '@/services/sync';
import { useAppStore } from '@/store/appStore';
import type { Prompt } from '@/types';
import { colors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

export function SettingsScreen() {
  const prompts = useQuery<Prompt[]>({ queryKey: ['prompts'], queryFn: promptRepo.list });
  const [gistId, setGistId] = useSetting('gistId');
  const [deepSeekApiKey, setDeepSeekApiKey] = useSecureSetting('deepSeekApiKey');
  const [token, setToken] = useState('');
  const { fontSize, lineHeightRatio, themeMode, setFontSize, setLineHeightRatio, setThemeMode } = useAppStore();
  const updateFontSize = (next: number) => {
    const value = Math.min(24, Math.max(14, next));
    setFontSize(value);
    settingsRepo.set('readerFontSize', String(value)).catch(() => undefined);
  };
  const updateLineHeight = (next: number) => {
    const value = Math.min(2, Math.max(1.35, Math.round(next * 100) / 100));
    setLineHeightRatio(value);
    settingsRepo.set('readerLineHeightRatio', String(value)).catch(() => undefined);
  };
  const cycleTheme = () => {
    const next = themeMode === 'system' ? 'dark' : themeMode === 'dark' ? 'light' : 'system';
    setThemeMode(next);
    settingsRepo.set('readerThemeMode', next).catch(() => undefined);
  };

  return (
    <SafeAreaView style={screenStyles.safe}>
      <ScrollView contentContainerStyle={screenStyles.content}>
        <View style={[screenStyles.header, styles.headerNoPadding]}>
          <Text style={screenStyles.title}>Settings</Text>
        </View>
        <Text style={screenStyles.sectionTitle}>AI</Text>
        <InlineInput label="DeepSeek Key" value={deepSeekApiKey} onChangeText={setDeepSeekApiKey} placeholder="sk-****************" secure />
        <SettingRow label="Default Prompt" value={prompts.data?.find((item: Prompt) => item.isDefault)?.name ?? '默认翻译'} onPress={() => router.push('/prompts')} />
        <Text style={screenStyles.sectionTitle}>Sync</Text>
        <InlineInput label="GitHub Token" value={token} onChangeText={setToken} placeholder="ghp_****************" secure />
        <InlineInput label="Gist ID" value={gistId} onChangeText={setGistId} placeholder="b1a2c3d4e5f6" />
        <Pressable
          style={styles.sync}
          onPress={async () => {
            if (token) await settingsRepo.setGithubToken(token);
            syncNow()
              .then(() => Alert.alert('同步完成'))
              .catch((error) => Alert.alert('同步失败', error instanceof Error ? error.message : '请检查配置'));
          }}
        >
          <Text style={screenStyles.link}>Sync Now</Text>
        </Pressable>
        <Text style={screenStyles.sectionTitle}>Reader</Text>
        <StepperRow label="Font Size" value={String(fontSize)} onDecrease={() => updateFontSize(fontSize - 1)} onIncrease={() => updateFontSize(fontSize + 1)} />
        <StepperRow label="Line Height" value={lineHeightRatio.toFixed(2)} onDecrease={() => updateLineHeight(lineHeightRatio - 0.1)} onIncrease={() => updateLineHeight(lineHeightRatio + 0.1)} />
        <SettingRow label="Theme" value={themeMode === 'system' ? 'System' : themeMode === 'dark' ? 'Dark' : 'Light'} onPress={cycleTheme} />
        <View style={styles.brand}>
          <View style={styles.logo}>
            <Text style={styles.logoText}>RSS</Text>
          </View>
          <View>
            <Text style={styles.brandTitle}>FeedMind</Text>
            <Text style={styles.brandSub}>AI-Powered RSS Reader</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const useSetting = (key: string): [string, (value: string) => void] => {
  const [value, setValue] = useState('');
  useQuery({
    queryKey: ['setting', key],
    queryFn: async () => {
      const next = await settingsRepo.get(key);
      setValue(next);
      return next;
    },
  });
  return [
    value,
    (next) => {
      setValue(next);
      settingsRepo.set(key, next).catch(() => undefined);
    },
  ];
};

const useSecureSetting = (key: 'deepSeekApiKey'): [string, (value: string) => void] => {
  const [value, setValue] = useState('');
  useQuery({
    queryKey: ['secureSetting', key],
    queryFn: async () => {
      const next = key === 'deepSeekApiKey' ? await settingsRepo.getDeepSeekApiKey() : '';
      setValue(next ?? '');
      return next;
    },
  });
  return [
    value,
    (next) => {
      setValue(next);
      settingsRepo.setDeepSeekApiKey(next).catch(() => undefined);
    },
  ];
};

const InlineInput = ({ label, value, onChangeText, placeholder, secure }: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  secure?: boolean;
}) => (
  <View style={styles.inputRow}>
    <Text style={styles.inputLabel}>{label}</Text>
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      secureTextEntry={secure}
      autoCapitalize="none"
      style={styles.input}
    />
  </View>
);

const StepperRow = ({ label, value, onDecrease, onIncrease }: {
  label: string;
  value: string;
  onDecrease: () => void;
  onIncrease: () => void;
}) => (
  <View style={styles.stepperRow}>
    <Text style={styles.inputLabel}>{label}</Text>
    <View style={styles.stepper}>
      <Pressable style={styles.stepperButton} onPress={onDecrease}>
        <Text style={styles.stepperText}>-</Text>
      </Pressable>
      <Text style={styles.stepperValue}>{value}</Text>
      <Pressable style={styles.stepperButton} onPress={onIncrease}>
        <Text style={styles.stepperText}>+</Text>
      </Pressable>
    </View>
  </View>
);

const styles = StyleSheet.create({
  headerNoPadding: {
    paddingHorizontal: 0,
  },
  inputRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  inputLabel: {
    width: 112,
    color: colors.text,
    fontSize: 14,
  },
  input: {
    flex: 1,
    textAlign: 'right',
    color: colors.secondary,
    fontSize: 13,
  },
  sync: {
    height: 48,
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  stepperRow: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepperButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperText: {
    color: colors.blue,
    fontSize: 18,
    fontWeight: '800',
  },
  stepperValue: {
    width: 54,
    color: colors.secondary,
    fontSize: 13,
    textAlign: 'center',
  },
  brand: {
    marginTop: 32,
    height: 78,
    borderRadius: 14,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
  },
  logo: {
    width: 50,
    height: 50,
    borderRadius: 12,
    backgroundColor: colors.page,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  logoText: {
    fontWeight: '900',
  },
  brandTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.text,
  },
  brandSub: {
    marginTop: 2,
    color: colors.secondary,
    fontSize: 14,
  },
});
