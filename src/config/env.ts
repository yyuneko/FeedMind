const stripTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const feedMindApiUrl = process.env.EXPO_PUBLIC_FEEDMIND_API_URL?.trim();

export const env = {
  feedMindApiUrl: stripTrailingSlash(feedMindApiUrl || 'http://localhost:8080'),
} as const;
