import assert from 'node:assert/strict';
import { highlightCode } from '../src/utils/highlight';

const samples = [
  ['function greet(name) { return name; }', 'javascript'],
  ['<main>Hello & goodbye</main>', 'xml'],
  ['SELECT id, title FROM articles WHERE is_read = false;', 'sql'],
] as const;

for (const [code, language] of samples) {
  const highlighted = highlightCode(code);
  const restored = highlighted.tokens.map((line) => line.map((token) => token.text).join('')).join('\n');
  assert.equal(highlighted.language, language);
  assert.equal(restored, code);
  assert(highlighted.tokens.flat().some((token) => token.scopes.length > 0));
}

const classNameHint = highlightCode('SELECT id FROM articles;', 'javascript');
assert.equal(classNameHint.language, 'javascript');

const autoDetected = highlightCode('SELECT id FROM articles;');
const unsupportedHint = highlightCode('SELECT id FROM articles;', 'not-a-language');
assert.equal(unsupportedHint.language, autoDetected.language);

console.log('highlight.js auto-detection checks passed');
