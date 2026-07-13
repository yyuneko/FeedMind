import { getPreferences } from '@/api/preferences';
import { useAppStore } from '@/store/appStore';

export const loadRemotePreferences = async () => {
  const preferences = await getPreferences();
  if (!preferences) return;

  const store = useAppStore.getState();
  // Language affects the whole UI, so apply it as soon as the preference arrives.
  store.setLanguageMode(preferences.languageMode);
  store.setFontSize(preferences.fontSize);
  store.setLineHeightRatio(preferences.lineHeightRatio);
  store.setThemeMode(preferences.themeMode);
};
