import type { AiProviderConfig, AiProviderId } from './types';

export const DEFAULT_AI_PROVIDER_ID: AiProviderId = 'deepseek';

export const AI_PROVIDERS: Record<AiProviderId, AiProviderConfig> = {
  deepseek: { id: 'deepseek', name: 'DeepSeek', defaultEndpoint: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
  openai: { id: 'openai', name: 'OpenAI', defaultEndpoint: 'https://api.openai.com/v1', defaultModel: 'gpt-5-mini', models: ['gpt-5.2', 'gpt-5-mini', 'gpt-4.1-mini'] },
  anthropic: { id: 'anthropic', name: 'Anthropic Claude', defaultEndpoint: 'https://api.anthropic.com/v1', defaultModel: 'claude-haiku-4-5', models: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'] },
  gemini: { id: 'gemini', name: 'Google Gemini', defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-3.5-flash', models: ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'] },
};

export const AI_PROVIDER_IDS = Object.keys(AI_PROVIDERS) as AiProviderId[];
export const isAiProviderId = (value: string): value is AiProviderId => AI_PROVIDER_IDS.includes(value as AiProviderId);
export const aiSettingKey = {
  provider: 'aiProvider',
  model: (providerId: AiProviderId) => `aiModel:${providerId}`,
  endpoint: (providerId: AiProviderId) => `aiEndpoint:${providerId}`,
};
