import { useEffect, useState } from 'react';
import { ensureDefaultPrompts, settingsRepo } from '@/db/repositories';
import { getLocale, getSystemLanguageMode } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { LanguageMode, ReaderFont, ReaderThemeMode } from '@/types';
import { useAuthStore } from '@/auth/authStore';
import { migrateDeviceSecrets, migrateLegacyAccountData } from '@/migrations/legacy';
import { loadRemotePreferences } from '@/services/userPreferences';

const loadReaderSettings = async () => {
  const [fontSize, lineHeightRatio, readerPageWidth, readerFont, themeMode, languageMode] = await Promise.all([
    settingsRepo.get('readerFontSize'),
    settingsRepo.get('readerLineHeightRatio'),
    settingsRepo.get('readerPageWidth'),
    settingsRepo.get('readerFont'),
    settingsRepo.get('readerThemeMode'),
    settingsRepo.get('languageMode'),
  ]);
  const store = useAppStore.getState();
  const nextFontSize = Number(fontSize);
  const nextLineHeightRatio = Number(lineHeightRatio);
  const nextReaderPageWidth = Number(readerPageWidth);
  if (Number.isFinite(nextFontSize) && nextFontSize > 0) store.setFontSize(nextFontSize);
  if (Number.isFinite(nextLineHeightRatio) && nextLineHeightRatio > 0) store.setLineHeightRatio(nextLineHeightRatio);
  if (Number.isFinite(nextReaderPageWidth) && nextReaderPageWidth >= 480 && nextReaderPageWidth <= 1200) store.setReaderPageWidth(nextReaderPageWidth);
  if (readerFont === 'system' || readerFont === 'source-han-serif' || readerFont === 'literata' || readerFont === 'source-serif-4') store.setReaderFont(readerFont as ReaderFont);
  if (themeMode === 'light' || themeMode === 'dark' || themeMode === 'system') store.setThemeMode(themeMode as ReaderThemeMode);
  if (languageMode === 'system' || languageMode === 'zh' || languageMode === 'en' || languageMode === 'ja') store.setLanguageMode(languageMode as LanguageMode);
  else {
    const defaultLanguageMode = getSystemLanguageMode();
    store.setLanguageMode(defaultLanguageMode);
    await settingsRepo.set('languageMode', defaultLanguageMode);
  }
};

export const useBootstrap = () => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    migrateDeviceSecrets()
      .then(loadReaderSettings)
      .then(() => useAuthStore.getState().restore())
      .then(() => useAuthStore.getState().user ? migrateLegacyAccountData().then(loadRemotePreferences) : undefined)
      .finally(() => setReady(true));
  }, []);

  return ready;
};
