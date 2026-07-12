const ACCESS_KEY = 'feedmind.auth.access';
const REFRESH_KEY = 'feedmind.auth.refresh';
export const tokenStorage = {
  async getAccess() { return sessionStorage.getItem(ACCESS_KEY); },
  async getRefresh() { return null; },
  async set(accessToken: string) { sessionStorage.setItem(ACCESS_KEY, accessToken); },
  async clear() { sessionStorage.removeItem(ACCESS_KEY); localStorage.removeItem(REFRESH_KEY); },
};
