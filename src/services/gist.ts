import type { SyncPayload } from '@/types';

const FILE_NAME = 'rss-ai-reader-sync.json';
const GIST_API = 'https://api.github.com/gists';

export const fetchGistPayload = async (token: string, gistId: string): Promise<SyncPayload | null> => {
  if (!token || !gistId) return null;
  const response = await fetch(`${GIST_API}/${gistId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) throw new Error(`Gist 读取失败：${response.status}`);
  const gist = (await response.json()) as { files?: Record<string, { content?: string }> };
  const content = gist.files?.[FILE_NAME]?.content;
  return content ? (JSON.parse(content) as SyncPayload) : null;
};

export const writeGistPayload = async (token: string, gistId: string, payload: SyncPayload) => {
  if (!token || !gistId) return;
  const response = await fetch(`${GIST_API}/${gistId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: {
        [FILE_NAME]: {
          content: JSON.stringify(payload, null, 2),
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Gist 写入失败：${response.status}`);
};
