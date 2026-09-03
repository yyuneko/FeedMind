import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = join(projectRoot, 'workers', 'admin-web', 'public');

const parseEnvFile = (path) => {
  if (!existsSync(path)) return {};
  const result = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[2].startsWith('#')) continue;
    result[match[1]] = match[2].replace(/^(?:"(.*)"|'(.*)')$/, (_, double, single) => double ?? single ?? '');
  }
  return result;
};

const fileEnv = {
  ...parseEnvFile(join(projectRoot, '.env')),
  ...parseEnvFile(join(projectRoot, '.env.local')),
};
const configuredTarget = process.env.FEEDMIND_DEV_ADMIN_API_PROXY_TARGET
  || fileEnv.FEEDMIND_DEV_ADMIN_API_PROXY_TARGET
  || 'https://admin.feedmind.cc/api';
const apiTarget = configuredTarget.replace(/\/+$/, '');
const adminOrigin = new URL(apiTarget).origin;
const portIndex = process.argv.indexOf('--port');
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT || 8083);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const readBody = async (request) => {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const requestHeaders = (request) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || ['host', 'connection', 'content-length', 'cookie', 'origin', 'accept-encoding'].includes(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('Accept-Encoding', 'identity');
  return headers;
};

const upstreamFetch = async (request, url) => fetch(url, {
  method: request.method,
  headers: requestHeaders(request),
  body: await readBody(request),
  redirect: 'manual',
  signal: AbortSignal.timeout(30_000),
});

const sendUpstream = async (upstream, response) => {
  const headers = {};
  upstream.headers.forEach((value, name) => {
    if (!['connection', 'content-encoding', 'content-length', 'set-cookie', 'transfer-encoding'].includes(name.toLowerCase())) headers[name] = value;
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, headers);
  response.end(body);
};

const sendJsonError = (response, status, code, message) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: { code, message } }));
};

const proxyApi = async (request, response, url) => {
  const target = `${apiTarget}${url.pathname.slice('/api'.length)}${url.search}`;
  const upstream = await upstreamFetch(request, target);
  if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.has('location')) {
    sendJsonError(response, 401, 'local_admin_login_required', '请完成 Admin Cloudflare Managed OAuth 登录');
    return;
  }
  await sendUpstream(upstream, response);
};

const proxyOAuth = async (request, response, url) => {
  const supplied = url.searchParams.get('url');
  if (!supplied || !['GET', 'POST'].includes(request.method || '')) {
    sendJsonError(response, 400, 'invalid_oauth_proxy_request', 'OAuth 代理请求无效');
    return;
  }
  const target = new URL(supplied);
  const allowed = target.protocol === 'https:' && (
    target.origin === adminOrigin || target.hostname.endsWith('.cloudflareaccess.com')
  );
  if (!allowed) {
    sendJsonError(response, 403, 'oauth_proxy_target_not_allowed', 'OAuth 代理目标不受信任');
    return;
  }
  await sendUpstream(await upstreamFetch(request, target), response);
};

const liveReloadClients = new Set();
watch(publicRoot, { recursive: true }, () => {
  for (const client of liveReloadClients) client.write('data: reload\n\n');
});

const serveStatic = (request, response, url) => {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { pathname = '/'; }
  const requested = resolve(publicRoot, pathname.replace(/^\/+/, '') || 'index.html');
  if (requested !== publicRoot && !requested.startsWith(`${publicRoot}${sep}`)) {
    sendJsonError(response, 403, 'invalid_path', '路径无效');
    return;
  }
  const file = existsSync(requested) && statSync(requested).isFile() ? requested : join(publicRoot, 'index.html');
  let body = readFileSync(file);
  if (extname(file) === '.html') {
    const script = '<script>new EventSource("/__feedmind/live-reload").onmessage=()=>location.reload();</script>';
    body = Buffer.from(body.toString('utf8').replace('</body>', `${script}</body>`), 'utf8');
  }
  response.writeHead(200, {
    'Content-Type': mimeTypes[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  if (request.method === 'HEAD') response.end(); else response.end(body);
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://localhost:${port}`);
  try {
    if (url.pathname === '/__feedmind/live-reload') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      response.write(': connected\n\n');
      liveReloadClients.add(response);
      request.on('close', () => liveReloadClients.delete(response));
      return;
    }
    if (url.pathname === '/__feedmind/oauth-proxy') return await proxyOAuth(request, response, url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await proxyApi(request, response, url);
    serveStatic(request, response, url);
  } catch (error) {
    if (!response.headersSent) sendJsonError(response, 502, 'admin_dev_proxy_failed', error instanceof Error ? error.message : '本地 Admin 代理失败');
    else response.end();
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`FeedMind Admin dev server: http://localhost:${port}`);
  console.log(`Remote Admin API: ${apiTarget}`);
});
