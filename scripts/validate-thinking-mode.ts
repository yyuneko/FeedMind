import assert from 'node:assert/strict';
import { emptyThinkingCoverage, isUnknownThinkingAnswer, markThinkingStageCovered, nextThinkingStage, splitThinkingArticle, thinkingCoverageComplete } from '../src/services/thinkingState';
import { parseAiJsonResponse } from '../src/ai/parseJson';

assert.equal(isUnknownThinkingAnswer('不知道'), true);
assert.equal(isUnknownThinkingAnswer("I don't know."), true);
assert.equal(isUnknownThinkingAnswer('我不知道作者为什么这样判断'), false);

let coverage = emptyThinkingCoverage();
coverage = markThinkingStageCovered(coverage, 'summary');
coverage = markThinkingStageCovered(coverage, 'argument');
coverage = markThinkingStageCovered(coverage, 'logic');
coverage = markThinkingStageCovered(coverage, 'critique');
coverage = markThinkingStageCovered(coverage, 'connection');
assert.equal(thinkingCoverageComplete(coverage), true);
assert.deepEqual(['summary', 'argument', 'logic', 'critique', 'connection'].map((stage) => nextThinkingStage(stage as any)), ['argument', 'logic', 'critique', 'connection', 'complete']);

const source = ['第一段'.repeat(40), '第二段'.repeat(40), '第三段'.repeat(40)].join('\n\n');
const chunks = splitThinkingArticle(source, 100);
assert.ok(chunks.length > 1);
assert.equal(chunks.join('\n\n').replace(/\n\n/g, ''), source.replace(/\n\n/g, ''));

assert.deepEqual(parseAiJsonResponse('```json\n{"question":"一个问题"}\n```'), { question: '一个问题' });
assert.throws(() => parseAiJsonResponse('{invalid'));

console.log('Thinking Mode validation passed.');
