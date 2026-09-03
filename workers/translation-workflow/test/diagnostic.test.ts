import { describe, expect, it, vi } from "vitest";
import { persistTranslationDiagnostic } from "../src/diagnostics";

describe("translation failure diagnostics", () => {
  it("stores the complete AI response in R2 and indexes it in D1", async () => {
    const put = vi.fn(async (..._args: unknown[]) => undefined);
    const bind = vi.fn((..._args: unknown[]) => undefined);
    const run = vi.fn(async () => ({ success: true, meta: { changes: 1 } }));
    const statement = {
      bind(...values: unknown[]) { bind(...values); return statement; },
      run,
    };
    const env = {
      CONTENT: { put },
      DB: { prepare: () => statement },
    };
    await persistTranslationDiagnostic(
      env as never,
      { translationId: "translation-1", attemptId: "attempt-2", requestId: "request-1" },
      3,
      "response_parse",
      200,
      '{"data":{"text":"not valid translation json"}}',
      new Error("Translation response is not valid JSON"),
    );
    expect(put).toHaveBeenCalledOnce();
    const [key, serialized] = put.mock.calls[0];
    expect(key).toMatch(/^translations\/translation-1\/diagnostics\/attempt-2\/.+\.json$/);
    expect(JSON.parse(String(serialized))).toMatchObject({
      translationId: "translation-1",
      attemptId: "attempt-2",
      batchIndex: 3,
      failureStage: "response_parse",
      responseStatus: 200,
      responseBody: '{"data":{"text":"not valid translation json"}}',
      errorMessage: "Translation response is not valid JSON",
    });
    expect(bind).toHaveBeenCalledWith(
      expect.any(String), "translation-1", "attempt-2", 3, "response_parse", key,
      "response_parse_failed", "Translation response is not valid JSON", expect.any(String),
    );
    expect(run).toHaveBeenCalledOnce();
  });
});
