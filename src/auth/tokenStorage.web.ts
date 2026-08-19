const ACCESS_KEY = 'feedmind.auth.access';
const REFRESH_KEY = 'feedmind.auth.refresh';
let accessToken: string | null = null;
let legacyStorageCleared = false;

const clearLegacyStorage = () => {
  if (legacyStorageCleared || typeof window === 'undefined') return;
  legacyStorageCleared = true;
  try { sessionStorage.removeItem(ACCESS_KEY); } catch { /* Storage may be unavailable. */ }
  try { localStorage.removeItem(REFRESH_KEY); } catch { /* Storage may be unavailable. */ }
};

export const tokenStorage = {
  async getAccess() { clearLegacyStorage(); return accessToken; },
  async getRefresh() { return null; },
  async set(nextAccessToken: string) { clearLegacyStorage(); accessToken = nextAccessToken; },
  async clear() { clearLegacyStorage(); accessToken = null; },
};
