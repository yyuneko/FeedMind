import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { apiRequest } from '@/api/client';
import { feedRepo as legacyFeedRepo, promptRepo as legacyPromptRepo, settingsRepo } from '@/db/repositories';

const PROVIDER_KEY = 'feedmind.ai.credentials.deepseek';
const getSecret = (key: string) => Platform.OS === 'web' ? Promise.resolve(localStorage.getItem(key)) : SecureStore.getItemAsync(key);
const setSecret = (key: string, value: string) => Platform.OS === 'web' ? Promise.resolve(localStorage.setItem(key, value)) : SecureStore.setItemAsync(key, value);
const delSecret = (key: string) => Platform.OS === 'web' ? Promise.resolve(localStorage.removeItem(key)) : SecureStore.deleteItemAsync(key);
export const migrateDeviceSecrets = async () => {
  if (await settingsRepo.get('deviceSecretsMigrationV1') === '1') return;
  try {
    const current = await getSecret(PROVIDER_KEY);
    const oldKey = Platform.OS === 'web' ? 'feedmind:secret:deepSeekApiKey' : 'deepSeekApiKey';
    const legacy = await getSecret(oldKey);
    if (!current && legacy) { await setSecret(PROVIDER_KEY, legacy); if (await getSecret(PROVIDER_KEY) === legacy) await delSecret(oldKey); }
    await delSecret(Platform.OS === 'web' ? 'feedmind:secret:githubToken' : 'githubToken');
    await settingsRepo.set('gistId', ''); await settingsRepo.set('deviceSecretsMigrationV1', '1');
  } catch { /* Retried on next startup; never block the app. */ }
};
const deviceId = async () => { let id = await settingsRepo.get('installationId'); if (!id) { id = `device-${Date.now()}-${Math.random().toString(36).slice(2)}`; await settingsRepo.set('installationId', id); } return id; };
export const migrateLegacyAccountData = async () => {
  if (await settingsRepo.get('accountMigrationV1') === '1') return;
  try {
    const [feeds, prompts, languageMode, themeMode, fontSize, lineHeightRatio] = await Promise.all([legacyFeedRepo.list(), legacyPromptRepo.list(), settingsRepo.get('languageMode'), settingsRepo.get('readerThemeMode'), settingsRepo.get('readerFontSize'), settingsRepo.get('readerLineHeightRatio')]);
    await apiRequest('/migrations', { method: 'POST', body: JSON.stringify({ deviceID: await deviceId(), batchKey: 'legacy-v1', version: 1, feeds: feeds.map((x) => ({ URL: x.url, Title: x.title, Category: x.category })), prompts: prompts.map((x) => ({ ID: x.id, Name: x.name, Content: x.content, IsDefault: x.isDefault })), preferences: { LanguageMode: languageMode || 'system', ThemeMode: themeMode || 'system', FontSize: Number(fontSize) || 17, LineHeightRatio: Number(lineHeightRatio) || 1.65 } }) });
    await settingsRepo.set('accountMigrationV1', '1');
  } catch { /* Preserve local data and compensate after the next login. */ }
};
