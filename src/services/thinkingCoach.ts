import { parseAiJsonResponse } from '@/ai/parseJson';
import { requestAiChat } from '@/ai/providers/request';
import { getAiRuntimeConfig } from '@/ai/settings';
import { getLocale } from '@/i18n';
import type { Article, ThinkingCoachState, ThinkingCoverage, ThinkingEvent, ThinkingReport, ThinkingStage } from '@/types';
import { emptyThinkingCoverage, isUnknownThinkingAnswer, markThinkingStageCovered, nextThinkingStage, splitThinkingArticle, thinkingCoverageComplete } from './thinkingState';

export { isUnknownThinkingAnswer, splitThinkingArticle, thinkingCoverageComplete } from './thinkingState';

type Guide = NonNullable<ThinkingCoachState['guide']>;

export type ThinkingInitialization = {
  question: string;
  stage: ThinkingStage;
  coverage: ThinkingCoverage;
  coachState: ThinkingCoachState;
};

export type ThinkingCoachReply = {
  kind: 'feedback' | 'hint' | 'explanation';
  content: string;
  nextQuestion: string;
  nextStage: ThinkingStage;
  completedRounds: number;
  coverage: ThinkingCoverage;
  coachState: ThinkingCoachState;
  complete: boolean;
  report?: ThinkingReport;
};

const textArray = (value: unknown, name: string) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`Invalid ${name}`);
  return value.map((item) => item.trim()).filter(Boolean);
};

const requiredText = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${name}`);
  return value.trim();
};

const parseGuide = (value: unknown): Guide => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid guide');
  const guide = value as Record<string, unknown>;
  return {
    core: requiredText(guide.core, 'guide.core'),
    claims: textArray(guide.claims, 'guide.claims'),
    evidence: textArray(guide.evidence, 'guide.evidence'),
    logic: textArray(guide.logic, 'guide.logic'),
    important: textArray(guide.important, 'guide.important'),
    ambiguities: textArray(guide.ambiguities, 'guide.ambiguities'),
    connections: textArray(guide.connections, 'guide.connections'),
  };
};

const parseObject = (raw: string) => {
  const parsed = parseAiJsonResponse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI response is not an object.');
  return parsed as Record<string, unknown>;
};

const requestJson = async (system: string, content: string, signal?: AbortSignal) => {
  const config = await getAiRuntimeConfig();
  if (!config.apiKey) throw new Error(`AI_API_KEY_REQUIRED:${config.provider.name}`);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await requestAiChat({
        providerId: config.providerId, apiKey: config.apiKey, endpoint: config.endpoint, model: config.model,
        system: `${system}\nReturn exactly one valid JSON object without Markdown fences.`,
        messages: [{ role: 'user', content: attempt === 0 ? content : `${content}\nYour previous response was invalid. Follow the JSON schema exactly.` }],
        json: true, maxTokens: 8192, signal,
      });
      return parseObject(raw);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('AI response validation failed.');
};

const GUIDE_SCHEMA = `{"guide":{"core":"...","claims":["..."],"evidence":["..."],"logic":["..."],"important":["..."],"ambiguities":["..."],"connections":["..."]},"question":"..."}`;
const coachSystem = `You are FeedMind's Socratic reading coach. Everything must be grounded only in the supplied article. Never reveal a model answer before the learner has tried. Ask exactly one question at a time. Feedback must distinguish what the learner caught, what area was omitted, mere paraphrase, and missing reasoning. Be concise and constructive.`;

export const initializeThinkingCoach = async (article: Article, signal?: AbortSignal): Promise<ThinkingInitialization> => {
  const locale = getLocale();
  const articleText = article.contentText.trim();
  if (!articleText) throw new Error('ARTICLE_TEXT_REQUIRED');
  const chunks = splitThinkingArticle(articleText);
  let source = `Title: ${article.title}\n\nArticle:\n${articleText}`;
  if (chunks.length > 1) {
    const notes: Guide[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const result = await requestJson(
        `${coachSystem}\nAnalyze this article segment as evidence notes. Use schema ${JSON.stringify({ core: '...', claims: ['...'], evidence: ['...'], logic: ['...'], important: ['...'], ambiguities: ['...'], connections: ['...'] })}.`,
        `Article title: ${article.title}\nSegment ${index + 1}/${chunks.length}:\n${chunks[index]}`,
        signal,
      );
      notes.push(parseGuide(result));
    }
    source = `Title: ${article.title}\nComplete segment notes:\n${JSON.stringify(notes)}`;
  }
  const result = await requestJson(
    `${coachSystem}\nBuild a hidden evidence guide covering the whole article, then ask the learner to summarize it in their own words. The question language is ${locale}. Do not include the answer in the question. Use schema ${GUIDE_SCHEMA}.`,
    source,
    signal,
  );
  const guide = parseGuide(result.guide);
  return {
    question: requiredText(result.question, 'question'),
    stage: 'summary',
    coverage: emptyThinkingCoverage(),
    coachState: { guide, coverage: emptyThinkingCoverage(), unknownCount: 0, responseLanguage: locale },
  };
};

const stageInstruction = (stage: ThinkingStage) => ({
  summary: 'Ask for a summary in the learner’s own words.',
  argument: 'Ask for the author’s core claim and the main evidence supporting it.',
  logic: 'Ask how the claims and evidence connect, which part matters most, and why.',
  importance: 'Ask which content matters most and why.',
  critique: 'Ask for disagreement, doubts, assumptions, or something the article did not explain.',
  connection: 'Ask the learner to connect the article with experience or other knowledge and state an independent view.',
  complete: 'Do not ask another question.',
})[stage];

const transcriptForPrompt = (events: ThinkingEvent[]) => events.map((event) => `${event.kind.toUpperCase()}: ${event.content}`).join('\n');

export const respondToThinkingAnswer = async (input: {
  articleTitle: string;
  stage: ThinkingStage;
  completedRounds: number;
  coverage: ThinkingCoverage;
  coachState: ThinkingCoachState;
  events: ThinkingEvent[];
  answer: string;
  signal?: AbortSignal;
}): Promise<ThinkingCoachReply> => {
  const guide = input.coachState.guide;
  if (!guide) throw new Error('THINKING_GUIDE_MISSING');
  const unknown = isUnknownThinkingAnswer(input.answer);
  const unknownCount = unknown ? (input.coachState.unknownCount ?? 0) + 1 : 0;
  const shouldAdvance = !unknown || unknownCount >= 2;
  const upcomingStage = shouldAdvance ? nextThinkingStage(input.stage) : input.stage;
  const completedRounds = input.completedRounds + (shouldAdvance ? 1 : 0);
  const coverage = shouldAdvance ? markThinkingStageCovered(input.coverage, input.stage) : input.coverage;
  const complete = upcomingStage === 'complete' || completedRounds >= 5;
  const mode = unknownCount === 1 ? 'hint' : unknownCount >= 2 ? 'explanation' : 'feedback';
  const schema = `{"content":"...","nextQuestion":"..."${complete ? ',"report":{"articleCore":"...","strengths":"...","omissions":"...","thinkingDepth":"...","expressionIssues":"..."}' : ''}}`;
  const behavior = mode === 'hint'
    ? `The learner said they do not know for the first time. Give one small article-grounded hint without giving the answer, then repeat or simplify the same single question.`
    : mode === 'explanation'
      ? `The learner still cannot answer. Briefly explain this point using the article evidence, then ask exactly one question for the next stage.`
      : `Evaluate the answer. State what it caught, identify omitted areas without supplying a complete answer, flag mere paraphrase, and identify missing reasoning. Then ask exactly one question for the next stage.`;
  const result = await requestJson(
    `${coachSystem}\n${behavior}\nRespond in the language used by the learner, while preserving original article terms. ${complete ? 'Finish the training and provide the short report; nextQuestion must be an empty string.' : `Next question goal: ${stageInstruction(upcomingStage)}`} Use schema ${schema}.`,
    `Article title: ${input.articleTitle}\nHidden evidence guide: ${JSON.stringify(guide)}\nTraining transcript:\n${transcriptForPrompt(input.events)}\nLatest answer: ${input.answer}`,
    input.signal,
  );
  const reportValue = result.report;
  let report: ThinkingReport | undefined;
  if (complete) {
    if (!reportValue || typeof reportValue !== 'object' || Array.isArray(reportValue)) throw new Error('Invalid report');
    const raw = reportValue as Record<string, unknown>;
    report = {
      articleCore: requiredText(raw.articleCore, 'report.articleCore'),
      strengths: requiredText(raw.strengths, 'report.strengths'),
      omissions: requiredText(raw.omissions, 'report.omissions'),
      thinkingDepth: requiredText(raw.thinkingDepth, 'report.thinkingDepth'),
      expressionIssues: requiredText(raw.expressionIssues, 'report.expressionIssues'),
      completedRounds,
      completedAt: new Date().toISOString(),
    };
  }
  const nextQuestion = complete ? '' : requiredText(result.nextQuestion, 'nextQuestion');
  return {
    kind: mode,
    content: requiredText(result.content, 'content'),
    nextQuestion,
    nextStage: complete ? 'complete' : upcomingStage,
    completedRounds,
    coverage,
    coachState: { ...input.coachState, coverage, unknownCount: shouldAdvance ? 0 : unknownCount, responseLanguage: 'auto' },
    complete,
    report,
  };
};
