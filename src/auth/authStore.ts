import { create } from 'zustand';
import { apiRequest } from '@/api/client';
import { loadRemotePreferences } from '@/services/userPreferences';
import { loginWithManagedOAuth, logoutManagedOAuth } from './managedOAuth';

export type CurrentUser = { id: string; email: string };
type State = { user: CurrentUser | null; restoring: boolean; setUser: (user: CurrentUser | null) => void;
  restore: () => Promise<void>; login: () => Promise<void>; logout: () => Promise<void> };
async function session(): Promise<CurrentUser> {
  const response = await apiRequest<{ data: { ownerId: string; identity: { email: string } } }>('/me');
  return { id: response.data.ownerId, email: response.data.identity.email };
}
export const useAuthStore = create<State>((set) => ({
  user: null, restoring: true, setUser: (user) => set({ user }),
  restore: async () => { try { set({ user: await session() }); } catch { set({ user: null }); } finally { set({ restoring: false }); } },
  login: async () => { await loginWithManagedOAuth(); const user = await session();
    try { await loadRemotePreferences(); } catch { /* 登录成功不应被偏好同步阻断。 */ } set({ user }); },
  logout: async () => { await logoutManagedOAuth(); set({ user: null }); },
}));
