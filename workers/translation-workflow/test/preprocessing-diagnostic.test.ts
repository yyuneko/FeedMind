import { describe, expect, it, vi } from "vitest";
import { persistPreprocessingDiagnostic } from "../src/preprocessing-diagnostics";

describe("article preprocessing failure diagnostics", () => {
  it("stores complete model input and output in R2 and indexes it in D1", async () => {
    const put = vi.fn(async (..._args: unknown[]) => undefined);
    const bind = vi.fn((..._args: unknown[]) => undefined);
    const run = vi.fn(async () => ({ success: true, meta: { changes: 1 } }));
    const statement = {
      bind(...values: unknown[]) { bind(...values); return statement; },
      run,
    };
    const env = { CONTENT: { put }, DB: { prepare: () => statement } };

    await persistPreprocessingDiagnostic(env as never, {
      articleId: "article-1",
      taskId: "task-1",
      runId: "run-1",
      system: "system prompt",
      user: '{"fullPlainText":"正文"}',
      responseStatus: 200,
      responseBody: '{"data":{"text":"invalid"}}',
      errorCode: "preprocessing_failed",
      error: new Error("Preprocessing response is invalid"),
    });

    expect(put).toHaveBeenCalledOnce();
    const [key, serialized] = put.mock.calls[0];
    expect(key).toMatch(/^articles\/article-1\/preprocessing-diagnostics\/task-1\/.+\.json$/);
    expect(JSON.parse(String(serialized))).toMatchObject({
      articleId: "article-1",
      taskId: "task-1",
      runId: "run-1",
      input: { system: "system prompt", user: '{"fullPlainText":"正文"}' },
      output: '{"data":{"text":"invalid"}}',
      responseStatus: 200,
      errorCode: "preprocessing_failed",
    });
    expect(bind).toHaveBeenCalledWith(
      expect.any(String), "task-1", "run-1", key, 200, "preprocessing_failed",
      "Preprocessing response is invalid", expect.any(String),
    );
    expect(run).toHaveBeenCalledOnce();
  });
});
