export interface Env {
  DEEPSEEK_API_KEY: string;
}

type TranslateRequest = {
  articleId?: string;
  title?: string;
  content?: string;
  prompt?: string;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return json({});
    if (url.pathname !== '/translate' || request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (!env.DEEPSEEK_API_KEY) return json({ error: 'DEEPSEEK_API_KEY is missing' }, 500);

    const body = (await request.json().catch(() => null)) as TranslateRequest | null;
    if (!body?.articleId || !body.title || !body.content || !body.prompt) {
      return json({ error: 'Invalid request body' }, 400);
    }

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: body.prompt,
          },
          {
            role: 'user',
            content: `标题：${body.title}\n\n正文：\n${body.content}`,
          },
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) return json({ error: await response.text() }, response.status);
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return json({
      articleId: body.articleId,
      content: data.choices?.[0]?.message?.content ?? '',
    });
  },
};
