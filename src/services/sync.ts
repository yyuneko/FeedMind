import { settingsRepo, syncRepo } from '@/db/repositories';
import { t } from '@/i18n';
import { fetchGistPayload, writeGistPayload } from './gist';

let timer: ReturnType<typeof setTimeout> | null = null;

const getSyncConfig = async () => {
  const [token, gistId] = await Promise.all([settingsRepo.getGithubToken(), settingsRepo.get('gistId')]);
  if (!token || !gistId) throw new Error(t('syncMissingConfig'));
  return { token, gistId };
};

export const saveSyncPayload = async () => {
  const { token, gistId } = await getSyncConfig();
  await writeGistPayload(token, gistId, await syncRepo.exportPayload());
};

export const pullSyncPayload = async (options?: { replacePrompts?: boolean }) => {
  const { token, gistId } = await getSyncConfig();
  const remote = await fetchGistPayload(token, gistId);
  if (remote) await syncRepo.applyPayload(remote, options);
};

export const scheduleSync = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    saveSyncPayload().catch(() => undefined);
  }, 3000);
};