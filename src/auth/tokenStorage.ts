import * as SecureStore from 'expo-secure-store';

const ACCESS_KEY = 'feedmind.auth.access';
const REFRESH_KEY = 'feedmind.auth.refresh';
export const tokenStorage = {
  getAccess: () => SecureStore.getItemAsync(ACCESS_KEY),
  getRefresh: () => SecureStore.getItemAsync(REFRESH_KEY),
  async set(accessToken: string, refreshToken: string) {
    await Promise.all([SecureStore.setItemAsync(ACCESS_KEY, accessToken), SecureStore.setItemAsync(REFRESH_KEY, refreshToken)]);
  },
  async clear() { await Promise.all([SecureStore.deleteItemAsync(ACCESS_KEY), SecureStore.deleteItemAsync(REFRESH_KEY)]); },
};
