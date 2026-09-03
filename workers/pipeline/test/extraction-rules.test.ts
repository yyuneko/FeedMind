import { describe, expect, it } from 'vitest';
import { extractArticleWithRule, validateFeedExtractionRule } from '../../../src/utils/extractionRules';
import { stripHtml } from '../../../src/utils/html';

const prose = (label: string) => `${label} `.repeat(80);

describe('feed extraction rules', () => {
  it('cuts a nested end boundary before the matched node and keeps preceding content', () => {
    const raw = `<html><body><main class="content"><section><h2>Final chapter</h2><p>${prose('body')}</p></section><div class="meta"><h2> PAGE\n METADATA </h2><p>Author profile</p></div><section><h2>Additional cards</h2></section></main></body></html>`;
    const result = extractArticleWithRule(raw, 'https://blog.example.test/posts/one', {
      hostname: 'blog.example.test', rootSelector: 'main.content',
      endBefore: { selector: 'h2', textEquals: 'page metadata' },
    });
    expect(result.strategy).toBe('site_rule');
    expect(stripHtml(result.html)).toContain('Final chapter');
    expect(stripHtml(result.html)).not.toContain('Author profile');
    expect(stripHtml(result.html)).not.toContain('Additional cards');
  });

  it('supports start boundaries, attribute matchers, and excluded subtrees', () => {
    const raw = `<body><article><div>Leading chrome</div><h1 data-zone="start">Title</h1><p>${prose('article')}</p><div class="toolbar"><svg></svg><svg></svg></div></article></body>`;
    const result = extractArticleWithRule(raw, 'https://example.test/post', {
      rootSelector: 'article', startAt: { selector: 'h1', attributeEquals: { name: 'data-zone', value: 'start' } },
      removeMatchers: [{ selector: '.toolbar' }],
    });
    expect(result.strategy).toBe('site_rule');
    expect(stripHtml(result.html)).not.toContain('Leading chrome');
    expect(stripHtml(result.html)).toContain('Title');
    expect(result.diagnostics.removedNodes).toBe(1);
  });

  it('falls back when URL constraints or a unique root do not match', () => {
    const raw = `<body><article><p>${prose('readable')}</p></article></body>`;
    expect(extractArticleWithRule(raw, 'https://other.test/post', {
      hostname: 'example.test', rootSelector: 'article',
    })).toMatchObject({ strategy: 'readability_fallback', diagnostics: { code: 'url_mismatch' } });
    expect(extractArticleWithRule(`<body><article></article><article></article></body>`, 'https://example.test/post', {
      rootSelector: 'article',
    })).toMatchObject({ strategy: 'readability_fallback', diagnostics: { code: 'root_ambiguous', rootMatches: 2 } });
  });

  it('rejects invalid selectors and conflicting boundaries', () => {
    expect(() => validateFeedExtractionRule({ rootSelector: '' })).toThrow('rootSelector');
    expect(() => validateFeedExtractionRule({ rootSelector: 'article', startAt: { selector: 'h1' }, startAfter: { selector: 'h2' } })).toThrow('mutually exclusive');
    expect(() => validateFeedExtractionRule({ rootSelector: 'article', removeMatchers: [{ selector: '[' }] })).toThrow('valid CSS selector');
  });
});
