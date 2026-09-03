import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useState } from 'react';
import { SettingRow } from '@/components/SettingRow';
import { t } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { LanguageMode, ReaderThemeMode } from '@/types';
import { colors, radius, spacing, typography, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';
import { useAuthStore } from '@/auth/authStore';
import { updatePreferences } from '@/api/preferences';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';
import { Ionicons } from '@expo/vector-icons';
import { exportPersonalConfig } from '@/services/personalConfigExport';

export function SettingsScreen() {
  const themeColors = useThemeColors();
  const desktop = useDesktopLayout();
  const [isExporting, setIsExporting] = useState(false);
  const { themeMode, languageMode, setThemeMode, setLanguageMode } = useAppStore();
  const user = useAuthStore((state) => state.user);
  const userEmail = user?.email ?? '';
  const updateThemeMode = (next: ReaderThemeMode) => {
    setThemeMode(next);
    updatePreferences({ themeMode: next }).catch(() => undefined);
  };
  const updateLanguageMode = (next: LanguageMode) => {
    setLanguageMode(next);
    updatePreferences({ languageMode: next }).catch(() => undefined);
  };
  const handleExport = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      await exportPersonalConfig();
    } catch (error) {
      Alert.alert(t('exportFailed'), error instanceof Error ? error.message : t('soonRetry'));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <ScrollView contentContainerStyle={[screenStyles.content, desktop && screenStyles.desktopContent, desktop && styles.desktopPage]}>
        <View style={[screenStyles.header, styles.headerNoPadding]}>
          <Text style={[screenStyles.title, { color: themeColors.text }]}>{t('settings')}</Text>
        </View>
        <View style={desktop && styles.desktopGrid}>
          <View style={desktop && styles.desktopGroup}>
            <SettingRow label={t('account')} value={userEmail} />
            <SettingRow label={t('exportPersonalConfig')} value={isExporting ? t('exporting') : ''} onPress={handleExport} />
            <SettingRow label={t('feeds')} value={t('sync')} onPress={() => router.push('/settings/sources')} />
            <SettingRow label="第三方阅读器接入" value="Google Reader API" onPress={() => router.push('/reader-access')} />
            <SettingRow label={t('signout')} value="" onPress={() => useAuthStore.getState().logout()} />
            <SettingRow label={t('help')} value="" onPress={() => router.push('/help')} />
          </View>
          <View style={desktop && styles.desktopGroup}>
            <Text style={[screenStyles.sectionTitle, { color: themeColors.text }]}>{t('reader')}</Text>
            <LanguageModeRow value={languageMode} desktop={desktop} onChange={updateLanguageMode} />
            <ThemeModeRow value={themeMode} onChange={updateThemeMode} />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

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
            <Pressable key={item.value} accessibilityRole="button" accessibilityState={{ selected: active }} style={({ pressed, focused }: any) => [styles.themeOption, active && { backgroundColor: themeColors.card }, pressed && { opacity: 0.72 }, focused && { borderColor: themeColors.blue, borderWidth: 2 }]} onPress={() => onChange(item.value)}>
              <Text style={[styles.themeOptionText, { color: active ? themeColors.text : themeColors.secondary }]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};

const LanguageModeRow = ({ value, desktop, onChange }: {
  value: LanguageMode;
  desktop: boolean;
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
      <Pressable accessibilityRole="button" accessibilityLabel={`${t('language')}，${current.label}`} accessibilityState={{ expanded: open }} style={[styles.dropdown, { backgroundColor: themeColors.page }]} onPress={() => setOpen(true)}>
        <Text style={[styles.dropdownText, { color: themeColors.text }]}>{current.label}</Text>
        <Ionicons name='chevron-down' style={[styles.dropdownArrow, { color: themeColors.secondary }]} />
      </Pressable>
      <Modal visible={open} transparent animationType={desktop ? "fade" : "slide"} onRequestClose={() => setOpen(false)}>
        <Pressable style={[styles.dropdownBackdrop, !desktop && styles.dropdownBackdropMobile, { backgroundColor: themeColors.scrimLight }]} onPress={() => setOpen(false)}>
          <View style={[styles.dropdownMenu, !desktop && styles.dropdownMenuMobile, { backgroundColor: themeColors.card, borderColor: themeColors.border }]}>
            {options.map((item) => {
              const active = item.value === value;
              return (
                <Pressable
                  key={item.value}
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected: active }}
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
  desktopPage: { paddingTop: spacing.xxl, paddingBottom: spacing.huge, maxWidth: 800 },
  desktopGrid: { width: '100%', maxWidth: 720, gap: spacing.section },
  desktopGroup: { width: '100%' },
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
    ...typography.control,
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
    borderRadius: radius.control,
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
    fontWeight: '600',
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
    ...typography.metadata,
    fontWeight: '600',
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
    backgroundColor: colors.scrimLight,
    alignItems: 'center',
  },
  dropdownBackdropMobile: { justifyContent: 'flex-end', paddingHorizontal: 0 },
  dropdownMenu: {
    width: '100%',
    maxWidth: 360,
    borderRadius: radius.panel,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  dropdownMenuMobile: { maxWidth: undefined, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingBottom: spacing.xxl },
  dropdownItem: {
    height: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dropdownItemText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
