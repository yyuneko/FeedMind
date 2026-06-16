import { settingsRepo, translationRepo } from '@/db/repositories';

export const translateArticle = async (input: {
  articleId: string;
  title: string;
  content: string;
  promptId: string;
  prompt: string;
  signal?: AbortSignal;
}) => {
  const apiKey = await settingsRepo.getDeepSeekApiKey();
  if (!apiKey) throw new Error('请先在 Settings 中配置 DeepSeek Key');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: input.signal,
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: input.prompt,
        },
        {
          role: 'user',
          content: `标题：${input.title}\n\n正文：\n${input.content}`,
        },
      ],
      temperature: 0.3,
    }),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || '翻译失败');
  }
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? '';
  await translationRepo.save(input.articleId, input.promptId, content);
  return content;
};
