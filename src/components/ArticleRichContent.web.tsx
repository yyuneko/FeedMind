import { createElement, useMemo } from 'react';
import { renderFormulaMarkup } from '@/utils/formula';

type ArticleRichContentProps = {
  html: string;
  width: number;
  color: string;
  backgroundColor: string;
  fontSize: number;
  lineHeight: number;
  fontFamily?: string;
};

export function ArticleRichContent({ html, width, color, backgroundColor, fontSize, lineHeight, fontFamily }: ArticleRichContentProps) {
  const content = useMemo(() => renderFormulaMarkup(html), [html]);
  return createElement('div', {
    dangerouslySetInnerHTML: { __html: content },
    style: { width, color, backgroundColor, fontSize, lineHeight: `${lineHeight}px`, fontFamily },
  });
}

