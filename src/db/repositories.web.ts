import { nowIso } from '@/utils/time';

type Setting = { key: string; value: string; updatedAt: string };

const DB_NAME = 'feedmind';
const DB_VERSION = 5;
let databasePromise: Promise<IDBDatabase> | null = null;

const requestResult = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

const transactionDone = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });

const openDatabase = () => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      for (const legacyStore of ['explanations', 'translations', 'prompts', 'articleStates', 'articles', 'feeds']) {
        if (db.objectStoreNames.contains(legacyStore)) db.deleteObjectStore(legacyStore);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error('Unable to open IndexedDB'));
    };
  });
  return databasePromise;
};

const getSetting = async (key: IDBValidKey) => {
  const db = await openDatabase();
  return requestResult(db.transaction('settings').objectStore('settings').get(key)) as Promise<Setting | undefined>;
};

const putSetting = async (value: Setting) => {
  const db = await openDatabase();
  const transaction = db.transaction('settings', 'readwrite');
  transaction.objectStore('settings').put(value);
  await transactionDone(transaction);
};

// Web keeps only device-local presentation preferences. D1/R2 remain the
// sole source of truth for subscriptions, articles, state and translations.
export const settingsRepo = {
  async get(key: string) {
    return (await getSetting(key))?.value ?? '';
  },
  async set(key: string, value: string) {
    await putSetting({ key, value, updatedAt: nowIso() });
  },
};
