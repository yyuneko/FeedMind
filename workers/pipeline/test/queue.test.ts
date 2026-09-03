import { beforeEach, describe, expect, it, vi } from "vitest";

const pipeline = vi.hoisted(() => ({
  processArticle: vi.fn(),
  processFeed: vi.fn(),
  scheduleDueWork: vi.fn(),
}));

vi.mock("../src/pipeline", () => pipeline);

import worker from "../src/index";

describe("pipeline queue failure policy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("acknowledges a failed article parse instead of retrying it automatically", async () => {
    pipeline.processArticle.mockRejectedValueOnce(new Error("parse failed"));
    const message = {
      body: { articleId: "article-1", requestId: "request-1" },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await worker.queue({ queue: "feedmind-article", messages: [message] }, {} as never);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("continues retrying feed fetch failures", async () => {
    pipeline.processFeed.mockRejectedValueOnce(new Error("feed failed"));
    const message = {
      body: { feedId: "feed-1", requestId: "request-1" },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await worker.queue({ queue: "feedmind-feed", messages: [message] }, {} as never);

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });
});
