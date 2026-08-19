import { useSyncExternalStore } from 'react';

import { translateArticle, type TranslateArticleInput, type TranslationProgress } from './translate';
import type { TranslationBlockResult } from '@/utils/translationHtml';

export type TranslationTaskStatus = 'idle' | 'pending' | 'success' | 'error';

export type TranslationTaskSnapshot = {
  key: string;
  articleId: string;
  promptId: string;
  status: TranslationTaskStatus;
  error: unknown;
  title: string;
  blocks: TranslationBlockResult[];
  totalBlocks: number;
  updatedAt: number;
};

type RunningTask = TranslationTaskSnapshot & {
  controller: AbortController;
  promise: Promise<string>;
};

type SettledListener = (task: TranslationTaskSnapshot) => void;

const idleSnapshot: TranslationTaskSnapshot = {
  key: '',
  articleId: '',
  promptId: '',
  status: 'idle',
  error: null,
  title: '',
  blocks: [],
  totalBlocks: 0,
  updatedAt: 0,
};
const tasks = new Map<string, TranslationTaskSnapshot>();
const runningTasks = new Map<string, RunningTask>();
const listeners = new Set<() => void>();
const settledListeners = new Set<SettledListener>();

const publish = (task: TranslationTaskSnapshot) => {
  tasks.set(task.key, task);
  listeners.forEach((listener) => listener());
};

export const createTranslationTaskKey = (input: Pick<TranslateArticleInput, 'articleId' | 'promptId' | 'sourceHash' | 'promptHash'>) =>
  `${input.articleId}:${input.promptId}:${input.sourceHash}:${input.promptHash}`;

export const startTranslationTask = (input: Omit<TranslateArticleInput, 'signal' | 'onProgress'>) => {
  const key = createTranslationTaskKey(input);
  const existing = runningTasks.get(key);
  if (existing) return existing.promise;

  const controller = new AbortController();
  const pending: TranslationTaskSnapshot = {
    key,
    articleId: input.articleId,
    promptId: input.promptId,
    status: 'pending',
    error: null,
    title: '',
    blocks: [],
    totalBlocks: input.blocks.length,
    updatedAt: Date.now(),
  };
  publish(pending);
  let latest = pending;

  const onProgress = (progress: TranslationProgress) => {
    latest = { ...latest, ...progress, updatedAt: Date.now() };
    publish(latest);
  };
  const promise = translateArticle({ ...input, signal: controller.signal, onProgress })
    .then((content) => {
      const success: TranslationTaskSnapshot = { ...latest, status: 'success', updatedAt: Date.now() };
      publish(success);
      settledListeners.forEach((listener) => listener(success));
      return content;
    })
    .catch((error: unknown) => {
      const failed: TranslationTaskSnapshot = { ...latest, status: 'error', error, updatedAt: Date.now() };
      publish(failed);
      settledListeners.forEach((listener) => listener(failed));
      throw error;
    })
    .finally(() => {
      runningTasks.delete(key);
    });

  runningTasks.set(key, { ...pending, controller, promise });
  return promise;
};

export const cancelTranslationTask = (key: string) => {
  runningTasks.get(key)?.controller.abort();
};

export const subscribeToSettledTranslationTasks = (listener: SettledListener) => {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
};

export const useTranslationTask = (key: string) => useSyncExternalStore(
  (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  () => tasks.get(key) ?? idleSnapshot,
  () => tasks.get(key) ?? idleSnapshot,
);
