import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { SettingRow } from '@/components/SettingRow';
import { promptRepo } from '@/api/repositories';
import { settingsRepo } from '@/db/repositories';
import { t } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { LanguageMode, Prompt, ReaderThemeMode } from '@/types';
import { colors, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';
import { credentialStore, DEEPSEEK_PROVIDER_ID } from '@/ai/credentials';
import { useAuthStore } from '@/auth/authStore';
import { updatePreferences } from '@/api/preferences';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';

export function SettingsScreen() {
  const prompts = useQuery<Prompt[]>({ queryKey: ['prompts'], queryFn: promptRepo.list });
  const themeColors = useThemeColors();
  const desktop = useDesktopLayout();
  const [deepSeekApiKey, setDeepSeekApiKey] = useSecureSetting('deepSeekApiKey');
  const { themeMode, languageMode, setThemeMode, setLanguageMode } = useAppStore();
  const updateThemeMode = (next: ReaderThemeMode) => {
    setThemeMode(next);
    updatePreferences({ themeMode: next }).catch(() => undefined);
  };
  const updateLanguageMode = (next: LanguageMode) => {
    setLanguageMode(next);
    updatePreferences({ languageMode: next }).catch(() => undefined);
  };

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <ScrollView contentContainerStyle={[screenStyles.content, desktop && screenStyles.desktopContent, desktop && styles.desktopPage]}>
        <View style={[screenStyles.header, styles.headerNoPadding]}>
          <Text style={[screenStyles.title, { color: themeColors.text }]}>{t('settings')}</Text>
        </View>
        <View style={desktop && styles.desktopGrid}>
          <View style={desktop && [styles.desktopCard, { backgroundColor: themeColors.card, borderColor: themeColors.border }]}>
            <Text style={[screenStyles.sectionTitle, { color: themeColors.text }]}>AI</Text>
            <InlineInput label="DeepSeek Key" value={deepSeekApiKey} onChangeText={setDeepSeekApiKey} placeholder="sk-****************" secure />
            <SettingRow label={t('defaultPrompt')} value={prompts.data?.find((item: Prompt) => item.isDefault)?.name ?? t('defaultTranslation')} onPress={() => router.push('/prompts')} />
            <SettingRow label={t('signout')} value="" onPress={() => useAuthStore.getState().logout()} />
            <SettingRow label={t('help')} value="" onPress={() => router.push('/help')} />
          </View>
          <View style={desktop && [styles.desktopCard, { backgroundColor: themeColors.card, borderColor: themeColors.border }]}>
            <Text style={[screenStyles.sectionTitle, { color: themeColors.text }]}>{t('reader')}</Text>
            <LanguageModeRow value={languageMode} onChange={updateLanguageMode} />
            <ThemeModeRow value={themeMode} onChange={updateThemeMode} />
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
      const next = key === 'deepSeekApiKey' ? await credentialStore.get(DEEPSEEK_PROVIDER_ID) : '';
      setValue(next ?? '');
      return next;
    },
  });
  return [
    value,
    (next) => {
      setValue(next);
      credentialStore.set(DEEPSEEK_PROVIDER_ID, next).catch(() => undefined);
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
  desktopPage: { paddingTop: 22, paddingBottom: 48 },
  desktopGrid: { flexDirection: 'row', gap: 24 },
  desktopCard: { flex: 1, minHeight: 300, paddingHorizontal: 22, paddingVertical: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, shadowColor: '#111827', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.04, shadowRadius: 14 },
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
  syncActions: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  syncButton: {
    flex: 1,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncButtonText: {
    color: colors.blue,
    fontSize: 13,
    fontWeight: '700',
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
});
