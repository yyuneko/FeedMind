import { useEffect, useState } from 'react';
import { ensureDefaultPrompts, settingsRepo } from '@/db/repositories';
import { syncNow } from '@/services/sync';
import { useAppStore } from '@/store/appStore';
import type { ReaderThemeMode } from '@/types';

const loadReaderSettings = async () => {
  const [fontSize, lineHeightRatio, themeMode] = await Promise.all([
    settingsRepo.get('readerFontSize'),
    settingsRepo.get('readerLineHeightRatio'),
    settingsRepo.get('readerThemeMode'),
  ]);
  const store = useAppStore.getState();
  const nextFontSize = Number(fontSize);
  const nextLineHeightRatio = Number(lineHeightRatio);
  if (Number.isFinite(nextFontSize) && nextFontSize > 0) store.setFontSize(nextFontSize);
  if (Number.isFinite(nextLineHeightRatio) && nextLineHeightRatio > 0) store.setLineHeightRatio(nextLineHeightRatio);
  if (themeMode === 'light' || themeMode === 'dark' || themeMode === 'system') store.setThemeMode(themeMode as ReaderThemeMode);
};

export const useBootstrap = () => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    ensureDefaultPrompts()
      .then(loadReaderSettings)
      .then(() => syncNow().catch(() => undefined))
      .finally(() => setReady(true));
  }, []);

  return ready;
};
