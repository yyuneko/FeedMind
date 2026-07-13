import assert from 'node:assert/strict';
import { AI_PROVIDERS, AI_PROVIDER_IDS, DEFAULT_AI_PROVIDER_ID, aiSettingKey } from '../src/ai/providers/config';
import { requestAiTranslation } from '../src/ai/providers/request';
import type { AiProviderId, AiTranslationRequest } from '../src/ai/providers/types';

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; init: RequestInit; body: any }> = [];

const mockResponseFor = (providerId: AiProviderId) => {
  const raw = JSON.stringify({ title: '标题', blocks: [['b0', '译文']] });
  if (providerId === 'anthropic') return { content: [{ type: 'text', text: raw }] };
  if (providerId === 'gemini') return { candidates: [{ content: { parts: [{ text: raw }] } }] };
  return { choices: [{ message: { content: raw } }] };
};

const baseInput = (providerId: AiProviderId): AiTranslationRequest => ({
  providerId,
  apiKey: `key-${providerId}`,
  endpoint: `${AI_PROVIDERS[providerId].defaultEndpoint}/`,
  model: AI_PROVIDERS[providerId].defaultModel,
  prompt: 'Return JSON.',
  title: 'Title',
  blocks: [{ id: 'b0', markup: 'Text' }],
  first: true,
});

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const providerId = AI_PROVIDER_IDS.find((id) => String(url).includes(new URL(AI_PROVIDERS[id].defaultEndpoint).host));
  assert.ok(providerId);
  const body = JSON.parse(String(init?.body));
  calls.push({ url: String(url), init: init ?? {}, body });
  return new Response(JSON.stringify(mockResponseFor(providerId)), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const main = async () => {
try {
  for (const providerId of AI_PROVIDER_IDS) {
    const raw = await requestAiTranslation(baseInput(providerId));
    assert.equal(JSON.parse(raw).blocks[0][1], '译文');
  }

  const [deepseek, openai, anthropic, gemini] = calls;
  assert.equal(deepseek.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(openai.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(deepseek.init.headers && (deepseek.init.headers as Record<string, string>).Authorization, 'Bearer key-deepseek');
  assert.deepEqual(deepseek.body.response_format, { type: 'json_object' });
  assert.equal(openai.body.model, AI_PROVIDERS.openai.defaultModel);

  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages');
  assert.equal((anthropic.init.headers as Record<string, string>)['x-api-key'], 'key-anthropic');
  assert.equal((anthropic.init.headers as Record<string, string>)['anthropic-version'], '2023-06-01');
  assert.equal(anthropic.body.system, 'Return JSON.');

  assert.equal(gemini.url, `https://generativelanguage.googleapis.com/v1beta/models/${AI_PROVIDERS.gemini.defaultModel}:generateContent`);
  assert.equal((gemini.init.headers as Record<string, string>)['x-goog-api-key'], 'key-gemini');
  assert.equal(gemini.body.generationConfig.responseMimeType, 'application/json');

  assert.equal(DEFAULT_AI_PROVIDER_ID, 'deepseek');
  assert.equal(aiSettingKey.model('gemini'), 'aiModel:gemini');
  assert.equal(aiSettingKey.endpoint('anthropic'), 'aiEndpoint:anthropic');

  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 })) as typeof fetch;
  await assert.rejects(() => requestAiTranslation(baseInput('openai')), /OpenAI request failed \(401\): invalid key/);

  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch;
  await assert.rejects(() => requestAiTranslation(baseInput('deepseek')), /missing translation content/);

  console.log('AI provider validation passed (4 providers)');
} finally {
  globalThis.fetch = originalFetch;
}
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
