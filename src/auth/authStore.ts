import { create } from 'zustand';
import { apiRequest } from '@/api/client';
import { loadRemotePreferences } from '@/services/userPreferences';
import { tokenStorage } from './tokenStorage';

export type CurrentUser = { ID?: string; Email?: string; Verified?: boolean; id?: string; email?: string; verified?: boolean };
type State = { user: CurrentUser | null; restoring: boolean; setUser: (user: CurrentUser | null) => void; restore: () => Promise<void>; login: (email: string, password: string) => Promise<void>; register: (email: string, password: string) => Promise<void>; verifyEmail: (token: string) => Promise<void>; resendVerification: (email: string) => Promise<void>; forgotPassword: (email: string) => Promise<void>; resetPassword: (token: string, password: string) => Promise<void>; logout: () => Promise<void> };
export const useAuthStore = create<State>((set) => ({
  user: null, restoring: true, setUser: (user) => set({ user }),
  restore: async () => { try { const x = await apiRequest<{ user: CurrentUser }>('/me'); set({ user: x.user }); } catch { set({ user: null }); } finally { set({ restoring: false }); } },
  login: async (email, password) => {
    const x = await apiRequest<{ user: CurrentUser; tokens: { accessToken: string; refreshToken: string } }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, deviceName: 'FeedMind' }) });
    await tokenStorage.set(x.tokens.accessToken, x.tokens.refreshToken);
    try {
      await loadRemotePreferences();
    } catch {
      // Preference loading must not turn a successful login into a failed login.
    }
    set({ user: x.user });
  },
  register: async (email, password) => { await apiRequest('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, deviceName: 'FeedMind' }) }); await tokenStorage.clear(); },
  verifyEmail: async (token) => { await apiRequest('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }); },
  resendVerification: async (email) => { await apiRequest('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) }); },
  forgotPassword: async (email) => { await apiRequest('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }); },
  resetPassword: async (token, password) => { await apiRequest('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) }); },
  logout: async () => { try { await apiRequest('/auth/logout', { method: 'POST' }); } finally { await tokenStorage.clear(); set({ user: null }); } },
}));
