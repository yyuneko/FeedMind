const ACCESS_KEY = 'feedmind.auth.access';
const REFRESH_KEY = 'feedmind.auth.refresh';
const CLIENT_KEY = 'feedmind.auth.oauthClient';
let accessToken: string | null = null;
let refreshToken: string | null = null;
let oauthClientId: string | null = null;

const isLocalDevelopment = () => typeof window !== 'undefined'
  && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
const readSession = (key: string) => {
  if (!isLocalDevelopment()) return null;
  try { return sessionStorage.getItem(key); } catch { return null; }
};
const writeSession = (key: string, value?: string) => {
  if (!isLocalDevelopment()) return;
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch { /* Storage may be unavailable. */ }
};

export const tokenStorage = {
  async getAccess() { return accessToken ?? readSession(ACCESS_KEY); },
  async getRefresh() { return refreshToken ?? readSession(REFRESH_KEY); },
  async getClientId() { return oauthClientId ?? readSession(CLIENT_KEY); },
  async set(nextAccessToken: string, nextRefreshToken?: string) {
    accessToken = nextAccessToken;
    refreshToken = nextRefreshToken ?? refreshToken;
    writeSession(ACCESS_KEY, accessToken);
    writeSession(REFRESH_KEY, refreshToken ?? undefined);
  },
  async clear() {
    accessToken = null;
    refreshToken = null;
    writeSession(ACCESS_KEY);
    writeSession(REFRESH_KEY);
  },
  async setClientId(nextClientId: string) {
    oauthClientId = nextClientId;
    writeSession(CLIENT_KEY, oauthClientId);
  },
};
