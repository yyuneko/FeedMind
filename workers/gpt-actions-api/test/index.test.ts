import { describe, expect, it } from "vitest";
import worker from "../src/index";

const testEnv = { MIGRATION_MODE: "active" } as never;

describe("MCP-only public boundary", () => {
  it("does not expose the former OpenAPI document or Actions routes", async () => {
    const schema = await worker.fetch(new Request("https://actions.example/openapi.json"), testEnv);
    const action = await worker.fetch(new Request("https://actions.example/gpt-actions/v1/articles"), testEnv);
    expect(schema.status).toBe(404);
    expect(action.status).toBe(404);
  });

  it("keeps MCP OAuth discovery metadata", async () => {
    const response = await worker.fetch(
      new Request("https://actions.example/.well-known/oauth-protected-resource/mcp"),
      testEnv,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: "https://actions.example/mcp",
      authorization_servers: ["https://actions.example"],
    });
  });

  it("keeps the worker health endpoint", async () => {
    const response = await worker.fetch(new Request("https://actions.example/health"), testEnv);
    expect(response.status).toBe(200);
  });
});
