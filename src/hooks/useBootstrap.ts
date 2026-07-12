import { useEffect, useState } from 'react';
import { ensureDefaultPrompts, settingsRepo } from '@/db/repositories';
import { getLocale, getSystemLanguageMode } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { LanguageMode, ReaderThemeMode } from '@/types';

const loadReaderSettings = async () => {
  const [fontSize, lineHeightRatio, themeMode, languageMode] = await Promise.all([
    settingsRepo.get('readerFontSize'),
    settingsRepo.get('readerLineHeightRatio'),
    settingsRepo.get('readerThemeMode'),
    settingsRepo.get('languageMode'),
  ]);
  const store = useAppStore.getState();
  const nextFontSize = Number(fontSize);
  const nextLineHeightRatio = Number(lineHeightRatio);
  if (Number.isFinite(nextFontSize) && nextFontSize > 0) store.setFontSize(nextFontSize);
  if (Number.isFinite(nextLineHeightRatio) && nextLineHeightRatio > 0) store.setLineHeightRatio(nextLineHeightRatio);
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
    loadReaderSettings()
      .then(() => ensureDefaultPrompts(getLocale()))
      .finally(() => setReady(true));
  }, []);

  return ready;
};
