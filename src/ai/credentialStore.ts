import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { AiProviderId } from './providers/types';

const keyFor = (providerId: AiProviderId) => `feedmind.ai.credentials.${providerId}`;

export const credentialStore = {
  async get(providerId: AiProviderId) {
    return Platform.OS === 'web' ? localStorage.getItem(keyFor(providerId)) : SecureStore.getItemAsync(keyFor(providerId));
  },
  async set(providerId: AiProviderId, value: string) {
    if (Platform.OS === 'web') localStorage.setItem(keyFor(providerId), value);
    else await SecureStore.setItemAsync(keyFor(providerId), value);
  },
  async remove(providerId: AiProviderId) {
    if (Platform.OS === 'web') localStorage.removeItem(keyFor(providerId));
    else await SecureStore.deleteItemAsync(keyFor(providerId));
  },
};
