import * as SecureStore from 'expo-secure-store';

const ACCESS_KEY = 'feedmind.auth.access';
const REFRESH_KEY = 'feedmind.auth.refresh';
const CLIENT_KEY = 'feedmind.auth.oauthClient';

export const tokenStorage = {
  getAccess: () => SecureStore.getItemAsync(ACCESS_KEY),
  getRefresh: () => SecureStore.getItemAsync(REFRESH_KEY),
  getClientId: () => SecureStore.getItemAsync(CLIENT_KEY),
  async set(accessToken: string, refreshToken?: string) {
    if (!refreshToken) throw new Error('Refresh token is required on native clients');
    await Promise.all([SecureStore.setItemAsync(ACCESS_KEY, accessToken), SecureStore.setItemAsync(REFRESH_KEY, refreshToken)]);
  },
  setClientId: (clientId: string) => SecureStore.setItemAsync(CLIENT_KEY, clientId),
  async clear() {
    await Promise.all([SecureStore.deleteItemAsync(ACCESS_KEY), SecureStore.deleteItemAsync(REFRESH_KEY)]);
  },
};
