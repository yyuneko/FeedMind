const adminAuth = (() => {
  const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  const resource = 'https://admin.feedmind.cc';
  const redirectUri = `${location.origin}/oauth`;
  const keys = {
    access: 'feedmind.admin.auth.access', refresh: 'feedmind.admin.auth.refresh', client: 'feedmind.admin.auth.client',
    verifier: 'feedmind.admin.auth.verifier', state: 'feedmind.admin.auth.state',
  };
  const proxy = (url) => `${location.origin}/__feedmind/oauth-proxy?url=${encodeURIComponent(url)}`;
  const encode = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const random = (length = 32) => { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return encode(bytes); };

  async function discovery() {
    const protectedResource = await fetch(proxy(`${resource}/.well-known/cloudflare-access-protected-resource/`));
    if (!protectedResource.ok) throw new Error('Admin Access 受保护资源元数据不可用');
    const resourceMetadata = await protectedResource.json();
    const issuer = resourceMetadata.authorization_servers?.[0];
    if (!issuer) throw new Error('Admin Access 未声明 OAuth 授权服务器');
    const response = await fetch(proxy(`${issuer}/.well-known/oauth-authorization-server`));
    if (!response.ok) throw new Error('Admin Access OAuth 元数据不可用');
    return response.json();
  }

  async function clientId(registrationEndpoint) {
    const stored = sessionStorage.getItem(keys.client);
    if (stored) return stored;
    const response = await fetch(proxy(registrationEndpoint), {
      method: 'POST', headers: {'Content-Type':'application/json', Accept:'application/json'},
      body: JSON.stringify({ client_name:'FeedMind Admin Local Web', resource, redirect_uris:[redirectUri],
        token_endpoint_auth_method:'none', grant_types:['authorization_code','refresh_token'], response_types:['code'] }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.client_id) throw new Error(result.error_description || '无法注册 Admin OAuth 客户端；请为 Admin Access 应用启用 Allow localhost clients');
    sessionStorage.setItem(keys.client, result.client_id);
    return result.client_id;
  }

  async function login() {
    if (!local) {
      location.href = `${location.origin}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(`${location.origin}/`)}`;
      return;
    }
    const metadata = await discovery();
    const id = await clientId(metadata.registration_endpoint);
    const verifier = random(48);
    const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const state = random();
    sessionStorage.setItem(keys.verifier, verifier);
    sessionStorage.setItem(keys.state, state);
    const url = new URL(metadata.authorization_endpoint);
    new URLSearchParams({ response_type:'code', client_id:id, redirect_uri:redirectUri, code_challenge:challenge,
      code_challenge_method:'S256', state, resource }).forEach((value, key) => url.searchParams.set(key, value));
    location.href = url.toString();
  }

  async function tokenRequest(parameters) {
    const metadata = await discovery();
    const response = await fetch(proxy(metadata.token_endpoint), {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded', Accept:'application/json'},
      body:new URLSearchParams(parameters).toString(),
    });
    const token = await response.json().catch(() => ({}));
    if (!response.ok || !token.access_token) throw new Error(token.error_description || 'Admin OAuth token 交换失败');
    sessionStorage.setItem(keys.access, token.access_token);
    if (token.refresh_token) sessionStorage.setItem(keys.refresh, token.refresh_token);
  }

  async function completeCallback() {
    if (!local) return;
    const query = new URLSearchParams(location.search);
    if (!query.has('code') && !query.has('error')) return;
    if (query.get('error')) throw new Error(query.get('error_description') || query.get('error'));
    if (query.get('state') !== sessionStorage.getItem(keys.state)) throw new Error('Admin OAuth state 校验失败');
    const verifier = sessionStorage.getItem(keys.verifier);
    const id = sessionStorage.getItem(keys.client);
    if (!verifier || !id) throw new Error('Admin OAuth 登录上下文已丢失');
    await tokenRequest({ grant_type:'authorization_code', client_id:id, code:query.get('code'), redirect_uri:redirectUri,
      code_verifier:verifier, resource });
    sessionStorage.removeItem(keys.verifier); sessionStorage.removeItem(keys.state);
    history.replaceState({}, '', '/');
  }

  async function refresh() {
    const refreshToken = sessionStorage.getItem(keys.refresh);
    const id = sessionStorage.getItem(keys.client);
    if (!local || !refreshToken || !id) return false;
    try { await tokenRequest({ grant_type:'refresh_token', client_id:id, refresh_token:refreshToken, resource }); return true; }
    catch { sessionStorage.removeItem(keys.access); sessionStorage.removeItem(keys.refresh); return false; }
  }

  async function authorizedFetch(url, init = {}, retry = true) {
    const access = local ? sessionStorage.getItem(keys.access) : null;
    const response = await fetch(url, { credentials:'same-origin', ...init,
      headers:{...(access ? {Authorization:`Bearer ${access}`} : {}), ...init.headers} });
    if (response.status === 401 && retry && await refresh()) return authorizedFetch(url, init, false);
    return response;
  }

  function logout() {
    if (!local) { location.href = `/cdn-cgi/access/logout?returnTo=${encodeURIComponent(location.origin)}`; return; }
    Object.values(keys).forEach((key) => sessionStorage.removeItem(key));
    location.reload();
  }

  return { authorizedFetch, completeCallback, hasSession:() => !local || Boolean(sessionStorage.getItem(keys.access)), local, login, logout };
})();

window.adminAuth = adminAuth;
