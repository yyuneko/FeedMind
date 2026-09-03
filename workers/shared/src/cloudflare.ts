export interface D1Result<T = unknown> {
  success: boolean;
  results?: T[];
  meta?: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface R2ObjectBody {
  body: ReadableStream<Uint8Array>;
  size: number;
  text(): Promise<string>;
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string, options?: unknown): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

export interface Queue<T = unknown> {
  send(message: T, options?: { contentType?: "json" | "text" | "bytes" }): Promise<void>;
}

export interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface QueueMessage<T> {
  body: T;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueMessageBatch<T> {
  queue: string;
  messages: QueueMessage<T>[];
}

export interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface WorkflowInstance {
  id: string;
  status(): Promise<unknown>;
  restart(options?: unknown): Promise<void>;
  terminate(options?: unknown): Promise<void>;
}

export interface WorkflowBinding<T = unknown> {
  create(options?: { id?: string; params?: T }): Promise<WorkflowInstance>;
  createBatch?(items: Array<{ id?: string; params?: T }>): Promise<WorkflowInstance[]>;
  get(id: string): Promise<WorkflowInstance>;
}
