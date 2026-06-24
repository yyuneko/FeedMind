import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SettingRow } from '@/components/SettingRow';
import { promptRepo, settingsRepo } from '@/db/repositories';
import { syncNow } from '@/services/sync';
import { useAppStore } from '@/store/appStore';
import type { Prompt, ReaderThemeMode } from '@/types';
import { colors, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

export function SettingsScreen() {
  const prompts = useQuery<Prompt[]>({ queryKey: ['prompts'], queryFn: promptRepo.list });
  const themeColors = useThemeColors();
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
  const updateThemeMode = (next: ReaderThemeMode) => {
    setThemeMode(next);
    settingsRepo.set('readerThemeMode', next).catch(() => undefined);
  };

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <ScrollView contentContainerStyle={screenStyles.content}>
        <View style={[screenStyles.header, styles.headerNoPadding]}>
          <Text style={[screenStyles.title, { color: themeColors.text }]}>Settings</Text>
        </View>
        <Text style={[screenStyles.sectionTitle, { color: themeColors.text }]}>AI</Text>
        <InlineInput label="DeepSeek Key" value={deepSeekApiKey} onChangeText={setDeepSeekApiKey} placeholder="sk-****************" secure />
        <SettingRow label="Default Prompt" value={prompts.data?.find((item: Prompt) => item.isDefault)?.name ?? '默认翻译'} onPress={() => router.push('/prompts')} />
        <Text style={[screenStyles.sectionTitle, { color: themeColors.text }]}>Sync</Text>
        <InlineInput label="GitHub Token" value={token} onChangeText={setToken} placeholder="ghp_****************" secure />
        <InlineInput label="Gist ID" value={gistId} onChangeText={setGistId} placeholder="b1a2c3d4e5f6" />
        <Pressable
          style={[styles.sync, { borderBottomColor: themeColors.border }]}
          onPress={async () => {
            if (token) await settingsRepo.setGithubToken(token);
            syncNow()
              .then(() => Alert.alert('同步完成'))
              .catch((error) => Alert.alert('同步失败', error instanceof Error ? error.message : '请检查配置'));
          }}
        >
          <Text style={[screenStyles.link, { color: themeColors.blue }]}>Sync Now</Text>
        </Pressable>
        <Text style={[screenStyles.sectionTitle, { color: themeColors.text }]}>Reader</Text>
        <StepperRow label="Font Size" value={String(fontSize)} onDecrease={() => updateFontSize(fontSize - 1)} onIncrease={() => updateFontSize(fontSize + 1)} />
        <StepperRow label="Line Height" value={lineHeightRatio.toFixed(2)} onDecrease={() => updateLineHeight(lineHeightRatio - 0.1)} onIncrease={() => updateLineHeight(lineHeightRatio + 0.1)} />
        <ThemeModeRow value={themeMode} onChange={updateThemeMode} />
        <View style={[styles.brand, { backgroundColor: themeColors.card, borderColor: themeColors.border }]}>
          <View style={[styles.logo, { backgroundColor: themeColors.page }]}>
            <Text style={[styles.logoText, { color: themeColors.text }]}>RSS</Text>
          </View>
          <View>
            <Text style={[styles.brandTitle, { color: themeColors.text }]}>FeedMind</Text>
            <Text style={[styles.brandSub, { color: themeColors.secondary }]}>AI-Powered RSS Reader</Text>
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
}) => {
  const themeColors = useThemeColors();

  return (
    <View style={[styles.inputRow, { borderBottomColor: themeColors.border }]}>
      <Text style={[styles.inputLabel, { color: themeColors.text }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={themeColors.subtle}
        secureTextEntry={secure}
        autoCapitalize="none"
        style={[styles.input, { color: themeColors.secondary }]}
      />
    </View>
  );
};

const StepperRow = ({ label, value, onDecrease, onIncrease }: {
  label: string;
  value: string;
  onDecrease: () => void;
  onIncrease: () => void;
}) => {
  const themeColors = useThemeColors();

  return (
    <View style={[styles.stepperRow, { borderBottomColor: themeColors.border }]}>
      <Text style={[styles.inputLabel, { color: themeColors.text }]}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable style={[styles.stepperButton, { backgroundColor: themeColors.pill }]} onPress={onDecrease}>
          <Text style={[styles.stepperText, { color: themeColors.blue }]}>-</Text>
        </Pressable>
        <Text style={[styles.stepperValue, { color: themeColors.secondary }]}>{value}</Text>
        <Pressable style={[styles.stepperButton, { backgroundColor: themeColors.pill }]} onPress={onIncrease}>
          <Text style={[styles.stepperText, { color: themeColors.blue }]}>+</Text>
        </Pressable>
      </View>
    </View>
  );
};

const themeModeOptions: Array<{ label: string; value: ReaderThemeMode }> = [
  { label: 'System', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
];

const ThemeModeRow = ({ value, onChange }: {
  value: ReaderThemeMode;
  onChange: (value: ReaderThemeMode) => void;
}) => {
  const themeColors = useThemeColors();

  return (
    <View style={[styles.themeRow, { borderBottomColor: themeColors.border }]}>
      <Text style={[styles.inputLabel, { color: themeColors.text }]}>Theme</Text>
      <View style={[styles.themeOptions, { backgroundColor: themeColors.page }]}>
        {themeModeOptions.map((item) => {
          const active = item.value === value;
          return (
            <Pressable key={item.value} style={[styles.themeOption, active && { backgroundColor: themeColors.card }]} onPress={() => onChange(item.value)}>
              <Text style={[styles.themeOptionText, { color: active ? themeColors.text : themeColors.secondary }]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  headerNoPadding: {
    paddingHorizontal: 0,
    height: 50,
  },
  inputRow: {
    minHeight: 43,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  inputLabel: {
    width: 112,
    color: colors.text,
    fontSize: 13,
    fontWeight: '500',
  },
  input: {
    flex: 1,
    textAlign: 'right',
    color: colors.secondary,
    fontSize: 12,
  },
  sync: {
    height: 43,
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  stepperRow: {
    height: 43,
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
  themeRow: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  themeOptions: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 2,
  },
  themeOption: {
    minWidth: 58,
    height: 28,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeOptionText: {
    fontSize: 12,
    fontWeight: '700',
  },
  brand: {
    marginTop: 34,
    height: 74,
    borderRadius: 18,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  logo: {
    width: 48,
    height: 48,
    borderRadius: 13,
    backgroundColor: colors.page,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  logoText: {
    fontWeight: '900',
    fontSize: 12,
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
