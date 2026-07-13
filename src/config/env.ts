const stripTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const feedMindApiUrl = process.env.EXPO_PUBLIC_FEEDMIND_API_URL?.trim();
const appEnv = process.env.EXPO_PUBLIC_APP_ENV?.trim();

export const env = {
  feedMindApiUrl: stripTrailingSlash(feedMindApiUrl || 'http://localhost:8080'),
  appEnv: appEnv === 'development' ? 'development' : 'production',
  isDevelopment: appEnv === 'development',
} as const;
