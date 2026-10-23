import { beforeEach, describe, expect, it, vi } from "vitest";

const pipeline = vi.hoisted(() => ({
  processArticle: vi.fn(),
  processFeed: vi.fn(),
  runDailyMaintenance: vi.fn(),
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

  it("leaves queued work untouched while migration is paused", async () => {
    const message = {
      body: { feedId: "feed-1", requestId: "request-1" }, attempts: 1,
      ack: vi.fn(), retry: vi.fn(),
    };
    await worker.queue({ queue: "feedmind-feed", messages: [message] }, { MIGRATION_MODE: "paused" } as never);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(pipeline.processFeed).not.toHaveBeenCalled();
  });

  it("runs retention cleanup only for the daily maintenance cron", async () => {
    pipeline.runDailyMaintenance.mockResolvedValueOnce(undefined);
    pipeline.scheduleDueWork.mockResolvedValueOnce(undefined);
    const waits: Promise<unknown>[] = [];
    const context = { waitUntil: (promise: Promise<unknown>) => waits.push(promise), passThroughOnException: vi.fn() };

    await worker.scheduled({ cron: "0 0 * * *", scheduledTime: Date.now() }, {} as never, context);
    await Promise.all(waits);

    expect(pipeline.runDailyMaintenance).toHaveBeenCalledOnce();
    expect(pipeline.scheduleDueWork).not.toHaveBeenCalled();
  });

  it("keeps ordinary scheduling on the frequent cron", async () => {
    pipeline.scheduleDueWork.mockResolvedValueOnce(undefined);
    const waits: Promise<unknown>[] = [];
    const context = { waitUntil: (promise: Promise<unknown>) => waits.push(promise), passThroughOnException: vi.fn() };

    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, {} as never, context);
    await Promise.all(waits);

    expect(pipeline.scheduleDueWork).toHaveBeenCalledOnce();
    expect(pipeline.runDailyMaintenance).not.toHaveBeenCalled();
  });

  it("does not create scheduled work in migration mode", async () => {
    const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, { MIGRATION_MODE: "read_only" } as never, context);
    expect(context.waitUntil).not.toHaveBeenCalled();
    expect(pipeline.scheduleDueWork).not.toHaveBeenCalled();
  });
});
