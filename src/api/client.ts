import { Platform } from 'react-native';
import { tokenStorage } from '@/auth/tokenStorage';
import { refreshManagedOAuth } from '@/auth/managedOAuth';
import { env } from '@/config/env';

const API_ROOT = Platform.OS === 'web' ? '/api/v1' : `${env.feedMindApiUrl}/v1`;
export class ApiError extends Error { constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) { super(message); } }
let refreshPromise: Promise<boolean> | null = null;
const refresh = () => {
  refreshPromise ??= refreshManagedOAuth().finally(() => { refreshPromise = null; });
  return refreshPromise;
};

export const apiRequest = async <T>(path: string, init: RequestInit = {}, retry = true): Promise<T> => {
  const access = await tokenStorage.getAccess();
  if (Platform.OS !== 'web' && !access) throw new ApiError(401, 'missing_access_token', '请通过 Cloudflare Access 登录');
  const response = await fetch(`${API_ROOT}${path}`, { ...init, credentials: 'include', headers: {
    Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(access ? { Authorization: `Bearer ${access}` } : {}), ...init.headers,
  } });
  if (response.status === 401 && retry && await refresh()) return apiRequest<T>(path, init, false);
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string; fields?: Record<string, string> } };
    throw new ApiError(response.status, data.error?.code ?? 'request_failed', data.error?.message ?? `请求失败 (${response.status})`, data.error?.fields);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
};
