import { settingsRepo } from '@/db/repositories';
import { credentialStore } from './credentialStore';
import { AI_PROVIDERS, DEFAULT_AI_PROVIDER_ID, aiSettingKey, isAiProviderId } from './providers/config';
import type { AiProviderId } from './providers/types';

export const getSelectedAiProviderId = async (): Promise<AiProviderId> => {
  const stored = await settingsRepo.get(aiSettingKey.provider);
  return isAiProviderId(stored) ? stored : DEFAULT_AI_PROVIDER_ID;
};

export const getAiRuntimeConfig = async () => {
  const providerId = await getSelectedAiProviderId();
  const provider = AI_PROVIDERS[providerId];
  const [apiKey, storedModel, storedEndpoint] = await Promise.all([
    credentialStore.get(providerId),
    settingsRepo.get(aiSettingKey.model(providerId)),
    settingsRepo.get(aiSettingKey.endpoint(providerId)),
  ]);
  return { providerId, provider, apiKey: apiKey?.trim() ?? '', model: storedModel.trim() || provider.defaultModel, endpoint: storedEndpoint.trim() || provider.defaultEndpoint };
};
