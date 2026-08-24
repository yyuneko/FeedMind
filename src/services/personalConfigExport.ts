import { Platform, Share } from 'react-native';
import { feedRepo, promptRepo } from '@/api/repositories';
import { getPreferences, type UserPreferences } from '@/api/preferences';

export type PersonalConfigExport = {
  feeds: Array<{ url: string; title: string; category: string }>;
  prompts: Array<{ name: string; content: string; isDefault: boolean }>;
  readingSettings: Omit<UserPreferences, 'version'>;
};

export const loadPersonalConfigExport = async (): Promise<PersonalConfigExport> => {
  const [feeds, prompts, preferences] = await Promise.all([
    feedRepo.listAll(),
    promptRepo.list(),
    getPreferences(),
  ]);

  if (!preferences) throw new Error('Reading settings are unavailable');

  return {
    feeds: feeds.map(({ url, title, category }) => ({ url, title, category })),
    prompts: prompts.map(({ name, content, isDefault }) => ({ name, content, isDefault })),
    readingSettings: {
      languageMode: preferences.languageMode,
      themeMode: preferences.themeMode,
      fontSize: preferences.fontSize,
      lineHeightRatio: preferences.lineHeightRatio,
    },
  };
};

export const savePersonalConfigExport = async (data: PersonalConfigExport) => {
  const json = JSON.stringify(data, null, 2);
  const filename = `feedmind-personal-config-${new Date().toISOString().slice(0, 10)}.json`;

  if (Platform.OS === 'web') {
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return;
  }

  await Share.share({ title: filename, message: json }, { dialogTitle: filename });
};

export const exportPersonalConfig = async () => {
  const data = await loadPersonalConfigExport();
  await savePersonalConfigExport(data);
};
