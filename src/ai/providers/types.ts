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
  onTextDelta?: (delta: string, accumulated: string) => void;
};

export type AiChatMessage = { role: 'user' | 'assistant'; content: string };

export type AiChatRequest = {
  providerId: AiProviderId;
  apiKey: string;
  endpoint: string;
  model: string;
  system: string;
  messages: AiChatMessage[];
  json?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
  onTextDelta?: (delta: string, accumulated: string) => void;
};
