import { settingsRepo, syncRepo } from '@/db/repositories';
import { t } from '@/i18n';
import { fetchGistPayload, writeGistPayload } from './gist';

let timer: ReturnType<typeof setTimeout> | null = null;

export const syncNow = async (options?: { replacePrompts?: boolean }) => {
  const [token, gistId] = await Promise.all([settingsRepo.getGithubToken(), settingsRepo.get('gistId')]);
  if (!token || !gistId) throw new Error(t('syncMissingConfig'));
  const remote = await fetchGistPayload(token, gistId);
  if (remote) await syncRepo.applyPayload(remote, options);
  await writeGistPayload(token, gistId, await syncRepo.exportPayload());
};

export const scheduleSync = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    syncNow().catch(() => undefined);
  }, 3000);
};
