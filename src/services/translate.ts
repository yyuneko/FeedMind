import { settingsRepo, translationRepo } from '@/db/repositories';
import { t } from '@/i18n';

export const translateArticle = async (input: {
  articleId: string;
  title: string;
  content: string;
  promptId: string;
  prompt: string;
  signal?: AbortSignal;
}) => {
  const apiKey = await settingsRepo.getDeepSeekApiKey();
  if (!apiKey) throw new Error(t('checkConfig'));
  const payload: RequestInit = {
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
          content: `目标语言参考「${input.prompt}」\n\n标题：${input.title}\n\n请翻译标题和正文，只返回 JSON，不要返回 Markdown 代码块或额外说明。你必须返回 {"title":"标题译文","content":"正文译文"}：title 必须是标题译文；content 必须是正文译文，并保留输入正文里的段落空行，不要增删或合并段落。\n\n正文：\n${input.content}`,
        },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  };

  const response = await fetch('https://api.deepseek.com/chat/completions', payload);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || t('translateFailed'));
  }
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? '';
  await translationRepo.save(input.articleId, input.promptId, content);
  return content;
};
