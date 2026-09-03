const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const enhanceExpoMiddleware = config.server.enhanceMiddleware;

// The Expo app does not import these root folders. Scope exclusions to this
// repository so dependency folders such as react-native-web/dist still resolve.
const escapedProjectRoot = __dirname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
config.resolver.blockList = new RegExp(
  `^(?:${escapedProjectRoot}[\\\\/](?:workers|server|dist|CLOUDFLARE|\\.wrangler)[\\\\/].*|.*[\\\\/]__tests__[\\\\/].*)$`,
  'i',
);

const stripTrailingSlash = (value) => value.replace(/\/+$/, '');

const getProxyTarget = () => {
  const configuredTarget = process.env.FEEDMIND_DEV_API_PROXY_TARGET
    || process.env.EXPO_PUBLIC_FEEDMIND_API_URL;
  return configuredTarget ? stripTrailingSlash(configuredTarget.trim()) : '';
};

const readRequestBody = async (request) => {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const upstreamHeaders = (request) => {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || ['host', 'connection', 'content-length', 'cookie', 'origin', 'accept-encoding'].includes(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  // Avoid forwarding browser compression negotiation. Some proxy stacks return
  // decompressed bytes while retaining upstream encoding metadata.
  headers.set('Accept-Encoding', 'identity');
  return headers;
};

const fetchUpstream = async (request, targetUrl) => fetch(targetUrl, {
  method: request.method,
  headers: upstreamHeaders(request),
  body: await readRequestBody(request),
  redirect: 'manual',
  signal: AbortSignal.timeout(30_000),
});

const sendUpstreamResponse = async (upstream, response) => {
  const responseHeaders = {};
  upstream.headers.forEach((value, name) => {
    if (!['content-encoding', 'content-length', 'set-cookie', 'transfer-encoding'].includes(name.toLowerCase())) {
      responseHeaders[name] = value;
    }
  });
  const responseBody = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, responseHeaders);
  response.end(responseBody);
};

const proxyApiRequest = async (request, response, target) => {
  const requestUrl = new URL(request.url, 'http://localhost');
  const targetUrl = `${target}${requestUrl.pathname.slice('/api'.length)}${requestUrl.search}`;
  const upstream = await fetchUpstream(request, targetUrl);

  if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.has('location')) {
    response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      error: {
        code: 'local_access_login_required',
        message: '远程 API 需要 Cloudflare Access 登录，请在 localhost 登录页完成 Managed OAuth。',
      },
    }));
    return;
  }

  await sendUpstreamResponse(upstream, response);
};

const proxyOAuthRequest = async (request, response, resourceTarget) => {
  const requestUrl = new URL(request.url, 'http://localhost');
  const suppliedUrl = requestUrl.searchParams.get('url');
  if (!suppliedUrl || !['GET', 'POST'].includes(request.method || '')) {
    response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: { code: 'invalid_oauth_proxy_request', message: 'OAuth 代理请求无效' } }));
    return;
  }
  const targetUrl = new URL(suppliedUrl);
  const resourceOrigin = new URL(resourceTarget).origin;
  const allowed = targetUrl.protocol === 'https:' && (
    targetUrl.origin === resourceOrigin || targetUrl.hostname.endsWith('.cloudflareaccess.com')
  );
  if (!allowed) {
    response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: { code: 'oauth_proxy_target_not_allowed', message: 'OAuth 代理目标不受信任' } }));
    return;
  }
  await sendUpstreamResponse(await fetchUpstream(request, targetUrl.toString()), response);
};

config.server.enhanceMiddleware = (middleware, metroServer) => {
  const expoMiddleware = enhanceExpoMiddleware(middleware, metroServer);

  return (request, response, next) => {
    const target = getProxyTarget();
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (target && pathname === '/__feedmind/oauth-proxy') {
      proxyOAuthRequest(request, response, target).catch((error) => {
        response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: {
          code: 'local_oauth_proxy_failed',
          message: error instanceof Error ? error.message : '本地 OAuth 代理请求失败',
        } }));
      });
      return;
    }
    if (!target || !(pathname === '/api' || pathname.startsWith('/api/'))) {
      return expoMiddleware(request, response, next);
    }

    proxyApiRequest(request, response, target).catch((error) => {
      response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        error: {
          code: 'local_api_proxy_failed',
          message: error instanceof Error ? error.message : '本地 API 代理请求失败',
        },
      }));
    });
  };
};

module.exports = config;
