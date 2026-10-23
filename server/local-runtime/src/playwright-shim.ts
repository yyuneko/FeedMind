import { chromium } from "playwright";

export type BrowserWorker = unknown;

export async function launch(_binding: unknown, options: Record<string, unknown> = {}) {
  const { keep_alive: _keepAlive, ...launchOptions } = options;
  return chromium.launch({ headless: true, ...launchOptions });
}
