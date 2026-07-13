import { AI_PROVIDERS } from './config';
import type { AiTranslationRequest } from './types';

const trimEndpoint = (endpoint: string) => endpoint.replace(/\/+$/, '');
const userContent = (input: AiTranslationRequest) => JSON.stringify(input.first
  ? { title: input.title, blocks: input.blocks.map((block) => [block.id, block.markup]) }
  : { blocks: input.blocks.map((block) => [block.id, block.markup]) });

const responseError = async (response: Response, providerName: string) => {
  let detail = '';
  try {
    const data = await response.json() as { error?: { message?: unknown } | unknown; message?: unknown };
    const providerError = data.error && typeof data.error === 'object' ? data.error as { message?: unknown } : undefined;
    if (providerError && typeof providerError.message === 'string') detail = providerError.message;
    else if (typeof data.message === 'string') detail = data.message;
    else if (typeof data.error === 'string') detail = data.error;
  } catch { /* Ignore malformed error payloads. */ }
  return new Error(`${providerName} request failed (${response.status})${detail ? `: ${detail}` : ''}`);
};

const requestChatCompletions = async (input: AiTranslationRequest) => {
  const provider = AI_PROVIDERS[input.providerId];
  const response = await fetch(`${trimEndpoint(input.endpoint)}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' }, signal: input.signal,
    body: JSON.stringify({ model: input.model, messages: [{ role: 'system', content: input.prompt }, { role: 'user', content: userContent(input) }], response_format: { type: 'json_object' } }),
  });
  if (!response.ok) throw await responseError(response, provider.name);
  const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  const raw = data.choices?.[0]?.message?.content;
  if (typeof raw !== 'string') throw new Error(`${provider.name} response is missing translation content.`);
  return raw;
};

const requestAnthropic = async (input: AiTranslationRequest) => {
  const provider = AI_PROVIDERS.anthropic;
  const response = await fetch(`${trimEndpoint(input.endpoint)}/messages`, {
    method: 'POST', headers: { 'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, signal: input.signal,
    body: JSON.stringify({ model: input.model, max_tokens: 16384, system: input.prompt, messages: [{ role: 'user', content: userContent(input) }] }),
  });
  if (!response.ok) throw await responseError(response, provider.name);
  const data = await response.json() as { content?: Array<{ type?: unknown; text?: unknown }> };
  const raw = data.content?.find((item) => item.type === 'text' && typeof item.text === 'string')?.text;
  if (typeof raw !== 'string') throw new Error(`${provider.name} response is missing translation content.`);
  return raw;
};

const requestGemini = async (input: AiTranslationRequest) => {
  const provider = AI_PROVIDERS.gemini;
  const response = await fetch(`${trimEndpoint(input.endpoint)}/models/${encodeURIComponent(input.model)}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': input.apiKey, 'Content-Type': 'application/json' }, signal: input.signal,
    body: JSON.stringify({ systemInstruction: { parts: [{ text: input.prompt }] }, contents: [{ role: 'user', parts: [{ text: userContent(input) }] }], generationConfig: { responseMimeType: 'application/json' } }),
  });
  if (!response.ok) throw await responseError(response, provider.name);
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
  const raw = data.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === 'string')?.text;
  if (typeof raw !== 'string') throw new Error(`${provider.name} response is missing translation content.`);
  return raw;
};

export const requestAiTranslation = (input: AiTranslationRequest) => {
  if (input.providerId === 'anthropic') return requestAnthropic(input);
  if (input.providerId === 'gemini') return requestGemini(input);
  return requestChatCompletions(input);
};
