import type { Article } from '@/types';
import { decodeHtmlText } from '@/utils/html';

/** Select exactly one title for the current interface locale. */
export function getArticleDisplayTitle(article: Pick<Article, 'title' | 'translatedTitle' | 'sourceTitleLocale' | 'translatedTitleLocale'>): string {
  const originalTitle = decodeHtmlText(article.title).trim();
  const translatedTitle = decodeHtmlText(article.translatedTitle ?? '').trim();
  const sourceMatchesInterface = Boolean(
    article.sourceTitleLocale
      && article.translatedTitleLocale
      && article.sourceTitleLocale === article.translatedTitleLocale,
  );

  return sourceMatchesInterface || !translatedTitle ? originalTitle : translatedTitle;
}
