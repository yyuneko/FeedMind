import { describe, expect, it, vi } from "vitest";
import { errorResponse } from "../../shared/src/http";

describe("shared API error responses", () => {
  it("returns a retryable 503 for the D1 daily quota error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = errorResponse(
        new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. [code: 7500]"),
        "request-7500",
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "database_quota_exceeded" },
        requestId: "request-7500",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("does not misclassify unrelated database errors as quota failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = errorResponse(new Error("D1_ERROR: no such table"), "request-db");
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "internal_error" } });
    } finally {
      log.mockRestore();
    }
  });
});
