import { Platform } from 'react-native';

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const feedMindApiUrl = process.env.EXPO_PUBLIC_FEEDMIND_API_URL?.trim();
const appEnv = process.env.EXPO_PUBLIC_APP_ENV?.trim();

export const env = {
  feedMindApiUrl: stripTrailingSlash(feedMindApiUrl || (Platform.OS === 'web' ? '' : appEnv === 'development' ? 'http://localhost:8787' : 'https://app.feedmind.cc/api')),
  appEnv: appEnv === 'development' ? 'development' : 'production',
  isDevelopment: appEnv === 'development',
} as const;
