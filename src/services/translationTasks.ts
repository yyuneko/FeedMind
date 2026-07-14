import { useSyncExternalStore } from 'react';

import { translateArticle, type TranslateArticleInput } from './translate';

export type TranslationTaskStatus = 'idle' | 'pending' | 'success' | 'error';

export type TranslationTaskSnapshot = {
  key: string;
  articleId: string;
  promptId: string;
  status: TranslationTaskStatus;
  error: unknown;
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

export const startTranslationTask = (input: Omit<TranslateArticleInput, 'signal'>) => {
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
    updatedAt: Date.now(),
  };
  publish(pending);

  const promise = translateArticle({ ...input, signal: controller.signal })
    .then((content) => {
      const success: TranslationTaskSnapshot = { ...pending, status: 'success', updatedAt: Date.now() };
      publish(success);
      settledListeners.forEach((listener) => listener(success));
      return content;
    })
    .catch((error: unknown) => {
      const failed: TranslationTaskSnapshot = { ...pending, status: 'error', error, updatedAt: Date.now() };
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
