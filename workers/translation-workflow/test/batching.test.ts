import { describe, expect, it } from "vitest";
import { translationBatchTokenBudget } from "../src/batching";

describe("translation batch token budget", () => {
  it("shrinks source batches when the model output limit is smaller", () => {
    expect(translationBatchTokenBudget(6000, 4096)).toBe(2048);
  });

  it("keeps the configured budget when the model has no explicit output limit", () => {
    expect(translationBatchTokenBudget(6000, null)).toBe(6000);
  });
});
