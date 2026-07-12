import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
export const DEEPSEEK_PROVIDER_ID = 'deepseek';
const keyFor = (providerId: string) => `feedmind.ai.credentials.${providerId}`;
export const credentialStore = {
  async get(providerId: string) { return Platform.OS === 'web' ? localStorage.getItem(keyFor(providerId)) : SecureStore.getItemAsync(keyFor(providerId)); },
  async set(providerId: string, value: string) { if (Platform.OS === 'web') localStorage.setItem(keyFor(providerId), value); else await SecureStore.setItemAsync(keyFor(providerId), value); },
  async remove(providerId: string) { if (Platform.OS === 'web') localStorage.removeItem(keyFor(providerId)); else await SecureStore.deleteItemAsync(keyFor(providerId)); },
};
