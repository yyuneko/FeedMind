import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { env } from '@/config/env';
import { tokenStorage } from './tokenStorage';

WebBrowser.maybeCompleteAuthSession();

const resource = new URL(env.feedMindApiUrl).origin;
const redirectUri = AuthSession.makeRedirectUri({ scheme: 'feedmind', path: 'oauth' });

async function discovery() {
  const protectedResourceResponse = await fetch(`${resource}/.well-known/cloudflare-access-protected-resource/`, {
    headers: { Accept: 'application/json' },
  });
  if (!protectedResourceResponse.ok) throw new Error('Cloudflare Access 受保护资源元数据不可用');
  const protectedResource = await protectedResourceResponse.json() as { authorization_servers?: string[] };
  const authorizationServer = protectedResource.authorization_servers?.[0];
  if (!authorizationServer) throw new Error('Cloudflare Access 未声明 OAuth 授权服务器');
  const response = await fetch(`${authorizationServer}/.well-known/oauth-authorization-server`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Cloudflare Access OAuth 授权服务器元数据不可用');
  const metadata = await response.json() as {
    authorization_endpoint?: string; token_endpoint?: string; registration_endpoint?: string; revocation_endpoint?: string;
  };
  if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.registration_endpoint) throw new Error('Cloudflare Access OAuth 元数据不完整');
  return { authorizationEndpoint: metadata.authorization_endpoint, tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: metadata.registration_endpoint, revocationEndpoint: metadata.revocation_endpoint };
}

async function clientId(registrationEndpoint: string): Promise<string> {
  const stored = await tokenStorage.getClientId();
  if (stored) return stored;
  const response = await fetch(registrationEndpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_name: 'FeedMind Android', resource, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  const result = await response.json().catch(() => ({})) as { client_id?: string; error_description?: string };
  if (!response.ok || !result.client_id) throw new Error(result.error_description || '无法注册 Cloudflare Access OAuth 客户端');
  await tokenStorage.setClientId(result.client_id);
  return result.client_id;
}

export async function loginWithManagedOAuth(): Promise<void> {
  const endpoints = await discovery();
  const id = await clientId(endpoints.registrationEndpoint);
  const request = new AuthSession.AuthRequest({ clientId: id, redirectUri, responseType: AuthSession.ResponseType.Code,
    usePKCE: true, extraParams: { resource } });
  const result = await request.promptAsync(endpoints);
  if (result.type !== 'success' || !result.params.code || !request.codeVerifier) {
    if (result.type === 'cancel' || result.type === 'dismiss') throw new Error('登录已取消');
    throw new Error('Cloudflare Access 登录失败');
  }
  const token = await AuthSession.exchangeCodeAsync({ clientId: id, code: result.params.code, redirectUri,
    extraParams: { code_verifier: request.codeVerifier, resource } }, endpoints);
  await tokenStorage.set(token.accessToken, token.refreshToken);
}

export async function refreshManagedOAuth(): Promise<boolean> {
  const [refreshToken, id] = await Promise.all([tokenStorage.getRefresh(), tokenStorage.getClientId()]);
  if (!refreshToken || !id) return false;
  try {
    const endpoints = await discovery();
    const token = await AuthSession.refreshAsync({ clientId: id, refreshToken, extraParams: { resource } }, endpoints);
    await tokenStorage.set(token.accessToken, token.refreshToken || refreshToken);
    return true;
  } catch { await tokenStorage.clear(); return false; }
}

export async function logoutManagedOAuth(): Promise<void> { await tokenStorage.clear(); }
