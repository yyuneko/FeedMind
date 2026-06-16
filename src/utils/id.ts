import * as Crypto from 'expo-crypto';

export const sha256 = (value: string) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);

export const createLocalId = async (prefix: string) => sha256(`${prefix}:${Date.now()}:${Math.random()}`);

export const createArticleId = (feedUrl: string, articleUrl: string | null, title: string, publishedAt: string | null) => {
  const raw = articleUrl ? `${feedUrl}${articleUrl}` : `${feedUrl}${title}${publishedAt ?? ''}`;
  return sha256(raw);
};
