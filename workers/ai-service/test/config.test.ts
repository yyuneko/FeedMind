import { describe, expect, it } from "vitest";
import { OPENROUTER_ENDPOINT, validateProfile } from "../src/config";
import type { AiProfileConfig } from "../src/types";

const base: AiProfileConfig = {
  id: "profile-1", profile: "fast", provider: "openrouter", endpoint: OPENROUTER_ENDPOINT,
  model: "openai/gpt-4.1-mini", maxOutputTokens: 4096, thinkingEnabled: false, parameters: { temperature: 0.2 },
};

describe("AI profile validation", () => {
  it("accepts an OpenRouter profile and normalizes its endpoint and model", () => {
    expect(validateProfile({ ...base, endpoint: `${OPENROUTER_ENDPOINT}/`, model: " openai/gpt-4.1-mini " }))
      .toMatchObject({ provider: "openrouter", endpoint: OPENROUTER_ENDPOINT, model: "openai/gpt-4.1-mini" });
  });

  it("accepts an empty or large maximum output token setting", () => {
    expect(validateProfile({ ...base, maxOutputTokens: null }).maxOutputTokens).toBeNull();
    expect(validateProfile({ ...base, maxOutputTokens: 1_000_000 }).maxOutputTokens).toBe(1_000_000);
  });

  it("rejects non-OpenRouter providers, endpoints, and extension parameters", () => {
    expect(() => validateProfile({ ...base, provider: "openai" as "openrouter" })).toThrow(/Only OpenRouter/);
    expect(() => validateProfile({ ...base, endpoint: "https://attacker.example/v1" })).toThrow(/OpenRouter endpoint/);
    expect(() => validateProfile({ ...base, parameters: { dangerous_extension: true } })).toThrow(/not allowed/);
  });

  it("requires an OpenRouter vendor/model identifier", () => {
    expect(() => validateProfile({ ...base, model: "gpt-4.1-mini" })).toThrow(/vendor\/model/);
  });

  it("accepts OpenRouter batch model variants", () => {
    expect(validateProfile({ ...base, model: "google/gemini-3.6-flash:batch" }).model)
      .toBe("google/gemini-3.6-flash:batch");
  });
});
