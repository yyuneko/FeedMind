import { settingsRepo, syncRepo } from '@/db/repositories';
import { fetchGistPayload, writeGistPayload } from './gist';

let timer: ReturnType<typeof setTimeout> | null = null;

export const syncNow = async () => {
  const [token, gistId] = await Promise.all([settingsRepo.getGithubToken(), settingsRepo.get('gistId')]);
  if (!token || !gistId) throw new Error('请先配置 GitHub Token 和 Gist ID');
  const remote = await fetchGistPayload(token, gistId);
  if (remote) await syncRepo.applyPayload(remote);
  await writeGistPayload(token, gistId, await syncRepo.exportPayload());
};

export const scheduleSync = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    syncNow().catch(() => undefined);
  }, 3000);
};
