import { AI_PROVIDERS } from './config';
import { streamFetch } from './streamFetch';
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

type StreamDataExtractor = (data: Record<string, unknown>) => string | undefined;

const readEventStream = async (response: Response, input: AiTranslationRequest, extract: StreamDataExtractor) => {
  if (!response.body) throw new Error(`${AI_PROVIDERS[input.providerId].name} response body is missing.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let eventBuffer = '';
  let output = '';

  const consumeEvent = (event: string) => {
    const payload = event.split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
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
  const choices = data.choices;
  if (!Array.isArray(choices)) return undefined;
  const choice = choices[0];
  if (!choice || typeof choice !== 'object') return undefined;
  const delta = (choice as Record<string, unknown>).delta;
  if (!delta || typeof delta !== 'object') return undefined;
  const content = (delta as Record<string, unknown>).content;
  return typeof content === 'string' ? content : undefined;
};

const anthropicDelta = (data: Record<string, unknown>) => {
  const delta = data.delta;
  if (!delta || typeof delta !== 'object') return undefined;
  const text = (delta as Record<string, unknown>).text;
  return typeof text === 'string' ? text : undefined;
};

const geminiDelta = (data: Record<string, unknown>) => {
  const candidates = data.candidates;
  if (!Array.isArray(candidates)) return undefined;
  const candidate = candidates[0];
  if (!candidate || typeof candidate !== 'object') return undefined;
  const content = (candidate as Record<string, unknown>).content;
  if (!content || typeof content !== 'object') return undefined;
  const parts = (content as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return undefined;
  const part = parts.find((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string');
  return part && typeof part === 'object' ? (part as Record<string, unknown>).text as string : undefined;
};

const requestChatCompletions = async (input: AiTranslationRequest) => {
  const provider = AI_PROVIDERS[input.providerId];
  const response = await streamFetch(`${trimEndpoint(input.endpoint)}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' }, signal: input.signal,
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: 'system', content: input.prompt }, { role: 'user', content: userContent(input) }],
      response_format: { type: 'json_object' },
      stream: true,
      ...(input.providerId === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
    }),
  });
  if (!response.ok) throw await responseError(response, provider.name);
  if (isEventStream(response)) {
    const raw = await readEventStream(response, input, chatDelta);
    if (!raw) throw new Error(`${provider.name} response is missing translation content.`);
    return raw;
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  const raw = data.choices?.[0]?.message?.content;
  if (typeof raw !== 'string') throw new Error(`${provider.name} response is missing translation content.`);
  return raw;
};

const requestAnthropic = async (input: AiTranslationRequest) => {
  const provider = AI_PROVIDERS.anthropic;
  const response = await streamFetch(`${trimEndpoint(input.endpoint)}/messages`, {
    method: 'POST', headers: { 'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, signal: input.signal,
    body: JSON.stringify({ model: input.model, max_tokens: 16384, stream: true, system: input.prompt, messages: [{ role: 'user', content: userContent(input) }] }),
  });
  if (!response.ok) throw await responseError(response, provider.name);
  if (isEventStream(response)) {
    const raw = await readEventStream(response, input, anthropicDelta);
    if (!raw) throw new Error(`${provider.name} response is missing translation content.`);
    return raw;
  }
  const data = await response.json() as { content?: Array<{ type?: unknown; text?: unknown }> };
  const raw = data.content?.find((item) => item.type === 'text' && typeof item.text === 'string')?.text;
  if (typeof raw !== 'string') throw new Error(`${provider.name} response is missing translation content.`);
  return raw;
};

const requestGemini = async (input: AiTranslationRequest) => {
  const provider = AI_PROVIDERS.gemini;
  const response = await streamFetch(`${trimEndpoint(input.endpoint)}/models/${encodeURIComponent(input.model)}:streamGenerateContent?alt=sse`, {
    method: 'POST', headers: { 'x-goog-api-key': input.apiKey, 'Content-Type': 'application/json' }, signal: input.signal,
    body: JSON.stringify({ systemInstruction: { parts: [{ text: input.prompt }] }, contents: [{ role: 'user', parts: [{ text: userContent(input) }] }], generationConfig: { responseMimeType: 'application/json' } }),
  });
  if (!response.ok) throw await responseError(response, provider.name);
  if (isEventStream(response)) {
    const raw = await readEventStream(response, input, geminiDelta);
    if (!raw) throw new Error(`${provider.name} response is missing translation content.`);
    return raw;
  }
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
