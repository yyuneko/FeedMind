import { validateProfile } from "./config";
import type { AiInvokeInput, AiProfileConfig, AiResult, AiUsage } from "./types";

interface RawResult {
  text: string;
  finishReason: string | null;
  usage: AiUsage;
}

const EMPTY_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
const OPENROUTER_BATCH_ENDPOINT = "https://openrouter.ai/api/beta/batches";
const BATCH_CUSTOM_ID = "feedmind-request-1";
const BATCH_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "expired"]);
const BATCH_NOT_FOUND_MAX_POLLS = 6;

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageFrom(value: unknown): AiUsage {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const completionDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown> : {};
  return {
    inputTokens: number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount),
    outputTokens: number(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount),
    thinkingTokens: number(completionDetails.reasoning_tokens ?? usage.thinking_tokens ?? usage.thoughtsTokenCount),
  };
}

async function providerError(response: Response): Promise<Error> {
  let message = "Upstream AI request failed";
  try {
    const body = await response.json() as Record<string, unknown>;
    const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
    const detail = error.message ?? body.message ?? body.code;
    if (typeof detail === "string" && detail) message = detail.slice(0, 500);
  } catch {
    // Do not include an untrusted body in logs or API errors.
  }
  return new Error(`AI upstream HTTP ${response.status}: ${message}`);
}

type DeltaExtractor = (payload: Record<string, unknown>) => { text?: string; finishReason?: string | null; usage?: AiUsage };

async function readSse(response: Response, extract: DeltaExtractor): Promise<RawResult> {
  if (!response.body) throw new Error("AI response body is missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let finishReason: string | null = null;
  let usage = EMPTY_USAGE;
  const consume = (event: string) => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let payload: unknown;
    try { payload = JSON.parse(data); } catch { return; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const delta = extract(payload as Record<string, unknown>);
    if (delta.text) output += delta.text;
    if (delta.finishReason !== undefined) finishReason = delta.finishReason;
    if (delta.usage) usage = delta.usage;
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    events.forEach(consume);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!output) throw new Error("AI response content is missing");
  return { text: output, finishReason, usage };
}

function openAiDelta(payload: Record<string, unknown>) {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] as Record<string, unknown> | undefined : undefined;
  const delta = choice?.delta as Record<string, unknown> | undefined;
  return {
    text: typeof delta?.content === "string" ? delta.content : undefined,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    usage: payload.usage ? usageFrom(payload.usage) : undefined,
  };
}

function chatBody(config: AiProfileConfig, input: AiInvokeInput, model: string, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "system", content: input.system }, ...input.messages],
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(config.maxOutputTokens === null ? {} : { max_tokens: config.maxOutputTokens }),
    reasoning: config.thinkingEnabled ? { enabled: true } : { effort: "none" },
    ...config.parameters,
  };
  if (input.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "feedmind_response", strict: true, schema: input.jsonSchema },
    };
  } else if (input.json) body.response_format = { type: "json_object" };
  return body;
}

function openAiResult(data: Record<string, unknown>): RawResult {
  const choice = Array.isArray(data.choices) ? data.choices[0] as Record<string, unknown> | undefined : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  if (typeof message?.content !== "string" || !message.content) throw new Error("AI response content is missing");
  return {
    text: message.content,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    usage: usageFrom(data.usage),
  };
}

function batchFailure(message: string): Error {
  return new Error(`AI upstream HTTP 502: ${message.replace(/[\r\n]/g, " ").slice(0, 450)}`);
}

function batchResult(payload: Record<string, unknown>): RawResult {
  const results = Array.isArray(payload.results) ? payload.results as Array<Record<string, unknown>> : [];
  const result = results.find((item) => item.custom_id === BATCH_CUSTOM_ID) ?? results[0];
  if (!result) throw batchFailure("OpenRouter batch completed without a result");
  if (result.error) {
    const error = result.error as Record<string, unknown>;
    throw batchFailure(typeof error.message === "string" ? error.message : "OpenRouter batch request failed");
  }
  const response = result.response && typeof result.response === "object"
    ? result.response as Record<string, unknown> : {};
  const statusCode = number(response.status_code ?? response.status);
  const body = response.body && typeof response.body === "object"
    ? response.body as Record<string, unknown>
    : result.body && typeof result.body === "object"
      ? result.body as Record<string, unknown>
      : response;
  if (statusCode >= 400) {
    const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
    throw batchFailure(typeof error.message === "string" ? error.message : `OpenRouter batch result returned HTTP ${statusCode}`);
  }
  return openAiResult(body);
}

async function openRouterBatch(
  config: AiProfileConfig,
  input: AiInvokeInput,
  apiKey: string,
  fetcher: typeof fetch,
  submitOnly: boolean,
  pollIntervalMs: number,
  maxPolls: number,
): Promise<RawResult> {
  const model = config.model.slice(0, -":batch".length);
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const createdResponse = await fetcher(OPENROUTER_BATCH_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({
      endpoint: "/v1/chat/completions",
      model,
      requests: [{ custom_id: BATCH_CUSTOM_ID, body: chatBody(config, input, model, false) }],
    }),
  });
  if (!createdResponse.ok) throw await providerError(createdResponse);
  const created = await createdResponse.json() as Record<string, unknown>;
  const createdData = created.data && typeof created.data === "object" ? created.data as Record<string, unknown> : created;
  const batchId = typeof createdData.id === "string" ? createdData.id : "";
  if (!batchId) throw batchFailure("OpenRouter batch response is missing its id");
  if (submitOnly) return { text: "Batch request accepted", finishReason: "submitted", usage: EMPTY_USAGE };

  for (let poll = 0; poll < maxPolls; poll++) {
    // A newly-created upstream batch may take a few seconds to become visible.
    // Delay the first lookup as well as subsequent polls to avoid racing creation.
    if (pollIntervalMs > 0) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const response = await fetcher(`${OPENROUTER_BATCH_ENDPOINT}/${encodeURIComponent(batchId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.status === 404 && poll + 1 < Math.min(maxPolls, BATCH_NOT_FOUND_MAX_POLLS)) continue;
    if (!response.ok) throw await providerError(response);
    const current = await response.json() as Record<string, unknown>;
    const currentData = current.data && typeof current.data === "object" ? current.data as Record<string, unknown> : current;
    const status = typeof currentData.status === "string" ? currentData.status.toLowerCase() : "";
    if (status === "completed") return batchResult(currentData);
    if (BATCH_TERMINAL_STATUSES.has(status)) throw batchFailure(`OpenRouter batch ended with status ${status}`);
  }
  throw batchFailure("OpenRouter batch did not complete within 30 minutes");
}

async function openRouter(config: AiProfileConfig, input: AiInvokeInput, apiKey: string, fetcher: typeof fetch): Promise<RawResult> {
  const body = chatBody(config, input, config.model, true);
  const response = await fetcher(`${config.endpoint}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await providerError(response);
  if (response.headers.get("Content-Type")?.includes("text/event-stream")) return readSse(response, openAiDelta);
  const data = await response.json() as Record<string, unknown>;
  return openAiResult(data);
}

export interface InvokeAiOptions {
  batchSubmitOnly?: boolean;
  batchPollIntervalMs?: number;
  batchMaxPolls?: number;
}

export async function invokeAi(
  rawConfig: AiProfileConfig,
  input: AiInvokeInput,
  apiKey: string,
  fetcher: typeof fetch = fetch,
  options: InvokeAiOptions = {},
): Promise<AiResult> {
  const config = validateProfile(rawConfig);
  if (!apiKey) throw new Error("OpenRouter API key is not configured");
  const started = Date.now();
  const result = config.model.endsWith(":batch")
    ? await openRouterBatch(config, input, apiKey, fetcher, options.batchSubmitOnly === true,
      options.batchPollIntervalMs ?? 10_000, options.batchMaxPolls ?? 174)
    : await openRouter(config, input, apiKey, fetcher);
  return {
    ...result,
    profileVersionId: config.id,
    provider: config.provider,
    model: config.model,
    latencyMs: Date.now() - started,
  };
}
