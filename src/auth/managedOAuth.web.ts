import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { env } from '@/config/env';
import { tokenStorage } from './tokenStorage';

WebBrowser.maybeCompleteAuthSession();

const resource = new URL(env.feedMindApiUrl).origin;
const isLocalDevelopment = () => ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
const redirectUri = AuthSession.makeRedirectUri({ path: 'oauth', preferLocalhost: true });
const localProxyUrl = (url: string) => `${location.origin}/__feedmind/oauth-proxy?url=${encodeURIComponent(url)}`;
const fetchUrl = (url: string) => isLocalDevelopment() ? localProxyUrl(url) : url;

async function discovery() {
  const protectedResourceUrl = `${resource}/.well-known/cloudflare-access-protected-resource/`;
  const protectedResourceResponse = await fetch(fetchUrl(protectedResourceUrl), { headers: { Accept: 'application/json' } });
  if (!protectedResourceResponse.ok) throw new Error('Cloudflare Access 受保护资源元数据不可用');
  const protectedResource = await protectedResourceResponse.json() as { authorization_servers?: string[] };
  const authorizationServer = protectedResource.authorization_servers?.[0];
  if (!authorizationServer) throw new Error('Cloudflare Access 未声明 OAuth 授权服务器');

  const metadataUrl = `${authorizationServer}/.well-known/oauth-authorization-server`;
  const response = await fetch(fetchUrl(metadataUrl), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Cloudflare Access OAuth 授权服务器元数据不可用');
  const metadata = await response.json() as {
    authorization_endpoint?: string; token_endpoint?: string; registration_endpoint?: string; revocation_endpoint?: string;
  };
  if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.registration_endpoint) {
    throw new Error('Cloudflare Access OAuth 元数据不完整');
  }
  return {
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: fetchUrl(metadata.token_endpoint),
    registrationEndpoint: fetchUrl(metadata.registration_endpoint),
    revocationEndpoint: metadata.revocation_endpoint ? fetchUrl(metadata.revocation_endpoint) : undefined,
  };
}

async function clientId(registrationEndpoint: string): Promise<string> {
  const stored = await tokenStorage.getClientId();
  if (stored) return stored;
  const response = await fetch(registrationEndpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_name: 'FeedMind Local Web', resource, redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  const result = await response.json().catch(() => ({})) as { client_id?: string; error_description?: string };
  if (!response.ok || !result.client_id) {
    throw new Error(result.error_description || '无法注册 Cloudflare Access OAuth 客户端；请确认 Access 已允许 localhost clients');
  }
  await tokenStorage.setClientId(result.client_id);
  return result.client_id;
}

export async function loginWithManagedOAuth(): Promise<void> {
  if (!isLocalDevelopment()) {
    location.assign(`${location.origin}/`);
    return;
  }
  const endpoints = await discovery();
  const id = await clientId(endpoints.registrationEndpoint);
  const request = new AuthSession.AuthRequest({ clientId: id, redirectUri, responseType: AuthSession.ResponseType.Code,
    usePKCE: true, extraParams: { resource } });
  const result = await request.promptAsync(endpoints);
  if (result.type !== 'success' || !result.params.code || !request.codeVerifier) {
    if (result.type === 'cancel' || result.type === 'dismiss') throw new Error('登录已取消');
    throw new Error(result.type === 'error' ? result.error?.message || 'Cloudflare Access 登录失败' : 'Cloudflare Access 登录失败');
  }
  const token = await AuthSession.exchangeCodeAsync({ clientId: id, code: result.params.code, redirectUri,
    extraParams: { code_verifier: request.codeVerifier, resource } }, endpoints);
  await tokenStorage.set(token.accessToken, token.refreshToken);
}

export async function refreshManagedOAuth(): Promise<boolean> {
  if (!isLocalDevelopment()) return false;
  const [storedRefreshToken, id] = await Promise.all([tokenStorage.getRefresh(), tokenStorage.getClientId()]);
  if (!storedRefreshToken || !id) return false;
  try {
    const endpoints = await discovery();
    const token = await AuthSession.refreshAsync({ clientId: id, refreshToken: storedRefreshToken,
      extraParams: { resource } }, endpoints);
    await tokenStorage.set(token.accessToken, token.refreshToken || storedRefreshToken);
    return true;
  } catch { await tokenStorage.clear(); return false; }
}

export async function logoutManagedOAuth(): Promise<void> {
  if (isLocalDevelopment()) { await tokenStorage.clear(); return; }
  location.assign(`${location.origin}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(location.origin)}`);
}
