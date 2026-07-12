import { Platform } from 'react-native';
import { tokenStorage } from '@/auth/tokenStorage';

const API_URL = (process.env.EXPO_PUBLIC_FEEDMIND_API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
export class ApiError extends Error { constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) { super(message); } }
let refreshPromise: Promise<boolean> | null = null;
const refresh = () => {
  refreshPromise ??= (async () => {
    const refreshToken = Platform.OS === 'web' ? undefined : await tokenStorage.getRefresh();
    const response = await fetch(`${API_URL}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(refreshToken ? { refreshToken } : {}) });
    if (!response.ok) { await tokenStorage.clear(); return false; }
    const data = await response.json() as { tokens: { accessToken: string; refreshToken: string } };
    await tokenStorage.set(data.tokens.accessToken, data.tokens.refreshToken);
    return true;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
};
export const apiRequest = async <T>(path: string, init: RequestInit = {}, retry = true): Promise<T> => {
  const access = Platform.OS === 'web' ? await tokenStorage.getAccess() : await tokenStorage.getAccess();
  const response = await fetch(`${API_URL}/api/v1${path}`, { ...init, credentials: 'include', headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(access ? { Authorization: `Bearer ${access}` } : {}), ...init.headers } });
  if (response.status === 401 && retry && !path.startsWith('/auth/')) { if (await refresh()) return apiRequest<T>(path, init, false); }
  if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string; fields?: Record<string, string> } }; throw new ApiError(response.status, data.error?.code ?? 'request_failed', data.error?.message ?? `Request failed (${response.status})`, data.error?.fields); }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
};
