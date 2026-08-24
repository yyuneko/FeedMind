import { AI_PROVIDERS } from './config';
import { streamFetch } from './streamFetch';
import type { AiChatRequest, AiTranslationRequest } from './types';

const trimEndpoint = (endpoint: string) => endpoint.replace(/\/+$/, '');

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

type StreamDataExtractor = (data: Record<string, unknown>) => string | undefined;

const readEventStream = async (response: Response, input: AiChatRequest, extract: StreamDataExtractor) => {
  if (!response.body) throw new Error(`${AI_PROVIDERS[input.providerId].name} response body is missing.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let eventBuffer = '';
  let output = '';
  const consumeEvent = (event: string) => {
    const payload = event.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!payload || payload === '[DONE]') return;
    let data: unknown;
    try { data = JSON.parse(payload); } catch { return; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const delta = extract(data as Record<string, unknown>);
    if (!delta) return;
    output += delta;
    input.onTextDelta?.(delta, output);
  };
  while (true) {
    const { done, value } = await reader.read();
    eventBuffer += decoder.decode(value, { stream: !done });
    const events = eventBuffer.split(/\r?\n\r?\n/u);
    eventBuffer = events.pop() ?? '';
    events.forEach(consumeEvent);
    if (done) break;
  }
  if (eventBuffer.trim()) consumeEvent(eventBuffer);
  return output;
};

const isEventStream = (response: Response) => response.headers.get('content-type')?.toLowerCase().includes('text/event-stream');
const chatDelta = (data: Record<string, unknown>) => {
  const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
  const delta = choice && typeof choice === 'object' ? (choice as Record<string, unknown>).delta : undefined;
  const content = delta && typeof delta === 'object' ? (delta as Record<string, unknown>).content : undefined;
  return typeof content === 'string' ? content : undefined;
};
const anthropicDelta = (data: Record<string, unknown>) => {
  const delta = data.delta;
  const value = delta && typeof delta === 'object' ? (delta as Record<string, unknown>).text : undefined;
  return typeof value === 'string' ? value : undefined;
};
const geminiDelta = (data: Record<string, unknown>) => {
  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : undefined;
  const content = candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>).content : undefined;
  const parts = content && typeof content === 'object' ? (content as Record<string, unknown>).parts : undefined;
  const part = Array.isArray(parts) ? parts.find((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') : undefined;
  return part && typeof part === 'object' ? (part as Record<string, unknown>).text as string : undefined;
};

const requestChatCompletions = async (input: AiChatRequest) => {
  const provider = AI_PROVIDERS[input.providerId];
  const response = await streamFetch(`${trimEndpoint(input.endpoint)}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' }, signal: input.signal,
    body: JSON.stringify({ model: input.model, messages: [{ role: 'system', content: input.system }, ...input.messages], ...(input.json ? { response_format: { type: 'json_object' } } : {}), stream: true, ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}), ...(input.providerId === 'deepseek' ? { thinking: { type: 'disabled' } } : {}) }),
  });
  if (!response.ok) throw await responseError(response, provider.name);
  if (isEventStream(response)) {
    const raw = await readEventStream(response, input, chatDelta);
    if (!raw) throw new Error(`${provider.name} response content is missing.`);
    return raw;
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  const raw = data.choices?.[0]?.message?.content;
  if (typeof raw !== 'string') throw new Error(`${provider.name} response content is missing.`);
  return raw;
};

const requestAnthropic = async (input: AiChatRequest) => {
  const provider = AI_PROVIDERS.anthropic;
  const response = await streamFetch(`${trimEndpoint(input.endpoint)}/messages`, {
    method: 'POST', headers: { 'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, signal: input.signal,
    body: JSON.stringify({ model: input.model, max_tokens: input.maxTokens ?? 8192, stream: true, system: `${input.system}${input.json ? '\nReturn one valid JSON object and no markdown.' : ''}`, messages: input.messages }),
  });
  if (!response.ok) throw await responseError(response, provider.name);
  if (isEventStream(response)) {
    const raw = await readEventStream(response, input, anthropicDelta);
    if (!raw) throw new Error(`${provider.name} response content is missing.`);
    return raw;
  }
  const data = await response.json() as { content?: Array<{ type?: unknown; text?: unknown }> };
  const raw = data.content?.find((item) => item.type === 'text' && typeof item.text === 'string')?.text;
  if (typeof raw !== 'string') throw new Error(`${provider.name} response content is missing.`);
  return raw;
};

const requestGemini = async (input: AiChatRequest) => {
  const provider = AI_PROVIDERS.gemini;
  const response = await streamFetch(`${trimEndpoint(input.endpoint)}/models/${encodeURIComponent(input.model)}:streamGenerateContent?alt=sse`, {
    method: 'POST', headers: { 'x-goog-api-key': input.apiKey, 'Content-Type': 'application/json' }, signal: input.signal,
    body: JSON.stringify({ systemInstruction: { parts: [{ text: input.system }] }, contents: input.messages.map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })), generationConfig: { ...(input.json ? { responseMimeType: 'application/json' } : {}), ...(input.maxTokens ? { maxOutputTokens: input.maxTokens } : {}) } }),
  });
  if (!response.ok) throw await responseError(response, provider.name);
  if (isEventStream(response)) {
    const raw = await readEventStream(response, input, geminiDelta);
    if (!raw) throw new Error(`${provider.name} response content is missing.`);
    return raw;
  }
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
  const raw = data.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === 'string')?.text;
  if (typeof raw !== 'string') throw new Error(`${provider.name} response content is missing.`);
  return raw;
};

export const requestAiChat = (input: AiChatRequest) => {
  if (input.providerId === 'anthropic') return requestAnthropic(input);
  if (input.providerId === 'gemini') return requestGemini(input);
  return requestChatCompletions(input);
};

export const requestAiTranslation = (input: AiTranslationRequest) => requestAiChat({
  providerId: input.providerId, apiKey: input.apiKey, endpoint: input.endpoint, model: input.model,
  system: input.prompt,
  messages: [{ role: 'user', content: JSON.stringify(input.first ? { title: input.title, blocks: input.blocks.map((block) => [block.id, block.markup]) } : { blocks: input.blocks.map((block) => [block.id, block.markup]) }) }],
  json: true, maxTokens: 16384, signal: input.signal, onTextDelta: input.onTextDelta,
});
