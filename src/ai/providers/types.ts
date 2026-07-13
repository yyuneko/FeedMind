import type { TranslationBlock } from '@/utils/translationHtml';

export type AiProviderId = 'deepseek' | 'openai' | 'anthropic' | 'gemini';

export type AiProviderConfig = {
  id: AiProviderId;
  name: string;
  defaultEndpoint: string;
  defaultModel: string;
  models: string[];
};

export type AiTranslationRequest = {
  providerId: AiProviderId;
  apiKey: string;
  endpoint: string;
  model: string;
  prompt: string;
  title: string;
  blocks: TranslationBlock[];
  first: boolean;
  signal?: AbortSignal;
};
