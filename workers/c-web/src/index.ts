interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

interface Env {
  ASSETS: Fetcher;
  C_API: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ data: { status: "ok", service: "c-web" } });
    if (url.pathname.startsWith("/api/")) {
      url.pathname = url.pathname.slice(4);
      const headers = new Headers(request.headers);
      headers.delete("Origin");
      return env.C_API.fetch(new Request(url, { method: request.method, headers, body: request.body, redirect: "manual" }));
    }
    if (url.pathname.startsWith("/oauth/")) {
      const headers = new Headers(request.headers);
      headers.delete("Origin");
      return env.C_API.fetch(new Request(url, { method: request.method, headers, body: request.body, redirect: "manual" }));
    }
    return env.ASSETS.fetch(request);
  },
};
