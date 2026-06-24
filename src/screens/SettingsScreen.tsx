import { Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { SettingRow } from '@/components/SettingRow';
import { promptRepo, settingsRepo } from '@/db/repositories';
import { t } from '@/i18n';
import { syncNow } from '@/services/sync';
import { useAppStore } from '@/store/appStore';
import type { LanguageMode, Prompt, ReaderThemeMode } from '@/types';
import { colors, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

const REPOSITORY_URL = 'https://github.com/yyuneko/FeedMind';

export function SettingsScreen() {
  const queryClient = useQueryClient();
  const prompts = useQuery<Prompt[]>({ queryKey: ['prompts'], queryFn: promptRepo.list });
  const themeColors = useThemeColors();
  const [gistId, setGistId] = useSetting('gistId');
  const [deepSeekApiKey, setDeepSeekApiKey] = useSecureSetting('deepSeekApiKey');
  const [token, setToken] = useState('');
  const { fontSize, lineHeightRatio, themeMode, languageMode, setFontSize, setLineHeightRatio, setThemeMode, setLanguageMode } = useAppStore();
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
  const updateLanguageMode = (next: LanguageMode) => {
    setLanguageMode(next);
    settingsRepo.set('languageMode', next).catch(() => undefined);
  };

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <ScrollView contentContainerStyle={screenStyles.content}>
        <View style={[screenStyles.header, styles.headerNoPadding]}>
          <Text style={[screenStyles.title, { color: themeColors.text }]}>{t('settings')}</Text>
        </View>
        <Text style={[screenStyles.sectionTitle, { color: themeColors.text }]}>AI</Text>
        <InlineInput label="DeepSeek Key" value={deepSeekApiKey} onChangeText={setDeepSeekApiKey} placeholder="sk-****************" secure />
        <SettingRow label={t('defaultPrompt')} value={prompts.data?.find((item: Prompt) => item.isDefault)?.name ?? t('defaultTranslation')} onPress={() => router.push('/prompts')} />
        <Text style={[screenStyles.sectionTitle, { color: themeColors.text }]}>{t('sync')}</Text>
        <InlineInput label="GitHub Token" value={token} onChangeText={setToken} placeholder="ghp_****************" secure />
        <InlineInput label="Gist ID" value={gistId} onChangeText={setGistId} placeholder="b1a2c3d4e5f6" />
        <Pressable
          style={[styles.sync, { borderBottomColor: themeColors.border }]}
          onPress={async () => {
            if (token) await settingsRepo.setGithubToken(token);
            syncNow({ replacePrompts: true })
              .then(() => {
                queryClient.invalidateQueries({ queryKey: ['prompts'] });
                Alert.alert(t('syncDone'));
              })
              .catch((error) => Alert.alert(t('syncFailed'), error instanceof Error ? error.message : t('checkConfig')));
          }}
        >
          <Text style={[screenStyles.link, { color: themeColors.blue }]}>{t('syncNow')}</Text>
        </Pressable>
        <SettingRow label={t('help')} value="" onPress={() => router.push('/help')} />
        <Text style={[screenStyles.sectionTitle, { color: themeColors.text }]}>{t('reader')}</Text>
        <StepperRow label={t('fontSize')} value={String(fontSize)} onDecrease={() => updateFontSize(fontSize - 1)} onIncrease={() => updateFontSize(fontSize + 1)} />
        <StepperRow label={t('lineHeight')} value={lineHeightRatio.toFixed(2)} onDecrease={() => updateLineHeight(lineHeightRatio - 0.1)} onIncrease={() => updateLineHeight(lineHeightRatio + 0.1)} />
        <LanguageModeRow value={languageMode} onChange={updateLanguageMode} />
        <ThemeModeRow value={themeMode} onChange={updateThemeMode} />
        <View style={[styles.brand, { backgroundColor: themeColors.card, borderColor: themeColors.border }]}>
          <View style={[styles.logo, { backgroundColor: themeColors.page }]}>
            <Text style={[styles.logoText, { color: themeColors.text }]}>RSS</Text>
          </View>
          <View>
            <Text style={[styles.brandTitle, { color: themeColors.text }]}>FeedMind</Text>
            <Text style={[styles.brandSub, { color: themeColors.secondary }]}>{t('aiPoweredRssReader')}</Text>
          </View>
          <Pressable style={[styles.github, { backgroundColor: themeColors.page }]} onPress={() => Linking.openURL(REPOSITORY_URL).catch(() => Alert.alert(t('linkOpenFailed')))}>
            <Ionicons name="logo-github" size={22} color={themeColors.text} />
          </Pressable>
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

const ThemeModeRow = ({ value, onChange }: {
  value: ReaderThemeMode;
  onChange: (value: ReaderThemeMode) => void;
}) => {
  const themeColors = useThemeColors();
  const options: Array<{ label: string; value: ReaderThemeMode }> = [
    { label: t('system'), value: 'system' },
    { label: t('light'), value: 'light' },
    { label: t('dark'), value: 'dark' },
  ];

  return (
    <View style={[styles.themeRow, { borderBottomColor: themeColors.border }]}>
      <Text style={[styles.inputLabel, { color: themeColors.text }]}>{t('theme')}</Text>
      <View style={[styles.themeOptions, { backgroundColor: themeColors.page }]}>
        {options.map((item) => {
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

const LanguageModeRow = ({ value, onChange }: {
  value: LanguageMode;
  onChange: (value: LanguageMode) => void;
}) => {
  const themeColors = useThemeColors();
  const [open, setOpen] = useState(false);
  const options: Array<{ label: string; value: LanguageMode }> = [
    { label: t('system'), value: 'system' },
    { label: '简体中文', value: 'zh' },
    { label: 'English', value: 'en' },
    { label: '日本語', value: 'ja' },
  ];
  const current = options.find((item) => item.value === value) ?? options[0];

  return (
    <View style={[styles.themeRow, { borderBottomColor: themeColors.border }]}>
      <Text style={[styles.inputLabel, { color: themeColors.text }]}>{t('language')}</Text>
      <Pressable style={[styles.dropdown, { backgroundColor: themeColors.page }]} onPress={() => setOpen(true)}>
        <Text style={[styles.dropdownText, { color: themeColors.text }]}>{current.label}</Text>
        <Text style={[styles.dropdownArrow, { color: themeColors.secondary }]}>⌄</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.dropdownBackdrop} onPress={() => setOpen(false)}>
          <View style={[styles.dropdownMenu, { backgroundColor: themeColors.card, borderColor: themeColors.border }]}>
            {options.map((item) => {
              const active = item.value === value;
              return (
                <Pressable
                  key={item.value}
                  style={[styles.dropdownItem, { borderBottomColor: themeColors.border }]}
                  onPress={() => {
                    onChange(item.value);
                    setOpen(false);
                  }}
                >
                  <Text style={[styles.dropdownItemText, { color: active ? themeColors.blue : themeColors.text }]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
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
  dropdown: {
    minWidth: 132,
    height: 32,
    borderRadius: 8,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownText: {
    fontSize: 13,
    fontWeight: '700',
  },
  dropdownArrow: {
    marginLeft: 12,
    fontSize: 16,
    lineHeight: 18,
  },
  dropdownBackdrop: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
    backgroundColor: 'rgba(0, 0, 0, 0.18)',
  },
  dropdownMenu: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  dropdownItem: {
    height: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dropdownItemText: {
    fontSize: 14,
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
  github: {
    width: 38,
    height: 38,
    marginLeft: 'auto',
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
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
