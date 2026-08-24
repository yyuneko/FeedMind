import type { ThinkingCoverage, ThinkingStage } from '@/types';

export const emptyThinkingCoverage = (): ThinkingCoverage => ({
  summary: false, argument: false, logic: false, importance: false, critique: false, connection: false,
});

export const isUnknownThinkingAnswer = (answer: string) => /^(不知道|不清楚|没想法|不会|答不出来|i\s*(?:do not|don't)\s*know|no idea|わからない|分からない)[。.!！?？\s]*$/iu.test(answer.trim());

export const nextThinkingStage = (stage: ThinkingStage): ThinkingStage => ({
  summary: 'argument', argument: 'logic', logic: 'critique', importance: 'critique', critique: 'connection', connection: 'complete', complete: 'complete',
})[stage] as ThinkingStage;

export const markThinkingStageCovered = (coverage: ThinkingCoverage, stage: ThinkingStage): ThinkingCoverage => {
  const next = { ...coverage };
  if (stage === 'logic') {
    next.logic = true;
    next.importance = true;
  } else if (stage !== 'complete' && stage in next) next[stage as keyof ThinkingCoverage] = true;
  return next;
};

export const thinkingCoverageComplete = (coverage: ThinkingCoverage) => Object.values(coverage).every(Boolean);

export const splitThinkingArticle = (text: string, limit = 18000) => {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/u).map((item) => item.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs.length ? paragraphs : [text]) {
    if (paragraph.length > limit) {
      if (current) chunks.push(current);
      for (let offset = 0; offset < paragraph.length; offset += limit) chunks.push(paragraph.slice(offset, offset + limit));
      current = '';
      continue;
    }
    if (current && current.length + paragraph.length + 2 > limit) {
      chunks.push(current);
      current = paragraph;
    } else current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) chunks.push(current);
  return chunks;
};
