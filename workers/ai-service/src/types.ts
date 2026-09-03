export type AiProvider = "openrouter";
export type AiProfile = "fast" | "quality";

export interface AiProfileConfig {
  id: string;
  profile: AiProfile;
  provider: AiProvider;
  endpoint: string;
  model: string;
  contextWindowTokens?: number | null;
  canonicalModel?: string | null;
  modelMetadataFetchedAt?: string | null;
  maxOutputTokens: number | null;
  thinkingEnabled: boolean;
  parameters: Record<string, unknown>;
}

export interface OpenRouterModelMetadata {
  model: string;
  canonicalModel: string;
  contextWindowTokens: number;
  fetchedAt: string;
}

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiInvokeInput {
  profile: AiProfile;
  system: string;
  messages: AiMessage[];
  json?: boolean;
  jsonSchema?: Record<string, unknown>;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

export interface AiResult {
  text: string;
  finishReason: string | null;
  usage: AiUsage;
  profileVersionId: string;
  provider: AiProvider;
  model: string;
  latencyMs: number;
}
