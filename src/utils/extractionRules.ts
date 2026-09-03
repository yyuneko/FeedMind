import { parseHTML } from 'linkedom';
import { extractReadableArticleHtml, htmlToBlocks, sanitizeArticleHtml, stripHtml } from './html';

export interface ExtractionAttributeMatcher {
  name: string;
  value: string;
}

export interface ExtractionNodeMatcher {
  selector: string;
  textEquals?: string;
  attributeEquals?: ExtractionAttributeMatcher;
}

export interface FeedExtractionRuleConfig {
  hostname?: string;
  includeSubdomains?: boolean;
  pathPrefixes?: string[];
  rootSelector: string;
  startAt?: ExtractionNodeMatcher;
  startAfter?: ExtractionNodeMatcher;
  endBefore?: ExtractionNodeMatcher;
  endAfter?: ExtractionNodeMatcher;
  removeMatchers?: ExtractionNodeMatcher[];
}

export type ExtractionStrategy = 'site_rule' | 'readability' | 'readability_fallback';

export interface ExtractionDiagnostics {
  code: string | null;
  rootMatches: number;
  startMatches: number | null;
  endMatches: number | null;
  removedNodes: number;
}

export interface ExtractedArticleResult {
  html: string;
  strategy: ExtractionStrategy;
  diagnostics: ExtractionDiagnostics;
}

const normalizedText = (value: string) => value.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim();
const selectorDocument = () => parseHTML('<body><main><p></p></main></body>').document;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('rule must be an object');
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string, maximum: number): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${name} is invalid`);
  return value.trim();
}

function selector(value: unknown, name: string): string {
  const result = optionalString(value, name, 500);
  if (!result) throw new Error(`${name} is required`);
  try { selectorDocument().querySelector(result); } catch { throw new Error(`${name} is not a valid CSS selector`); }
  return result;
}

function matcher(value: unknown, name: string): ExtractionNodeMatcher | undefined {
  if (value == null) return undefined;
  const input = object(value);
  const attributeInput = input.attributeEquals == null ? undefined : object(input.attributeEquals);
  const attributeEquals = attributeInput ? {
    name: optionalString(attributeInput.name, `${name}.attributeEquals.name`, 100) ?? '',
    value: optionalString(attributeInput.value, `${name}.attributeEquals.value`, 500) ?? '',
  } : undefined;
  if (attributeEquals && (!/^[A-Za-z_:][\w:.-]*$/u.test(attributeEquals.name) || !attributeEquals.value)) {
    throw new Error(`${name}.attributeEquals is invalid`);
  }
  return {
    selector: selector(input.selector, `${name}.selector`),
    ...(optionalString(input.textEquals, `${name}.textEquals`, 1000) ? { textEquals: optionalString(input.textEquals, `${name}.textEquals`, 1000) } : {}),
    ...(attributeEquals ? { attributeEquals } : {}),
  };
}

export function validateFeedExtractionRule(value: unknown): FeedExtractionRuleConfig {
  const input = object(value);
  const hostname = optionalString(input.hostname, 'hostname', 253)?.toLowerCase().replace(/\.$/u, '');
  if (hostname && (!/^[a-z0-9.-]+$/u.test(hostname) || hostname.includes('..'))) throw new Error('hostname is invalid');
  if (input.includeSubdomains != null && typeof input.includeSubdomains !== 'boolean') throw new Error('includeSubdomains is invalid');
  const pathPrefixes = input.pathPrefixes == null ? [] : input.pathPrefixes;
  if (!Array.isArray(pathPrefixes) || pathPrefixes.length > 20 || pathPrefixes.some((item) => typeof item !== 'string' || !item.startsWith('/') || item.length > 500)) {
    throw new Error('pathPrefixes is invalid');
  }
  const removeInputs = input.removeMatchers == null ? [] : input.removeMatchers;
  if (!Array.isArray(removeInputs) || removeInputs.length > 30) throw new Error('removeMatchers is invalid');
  const startAt = matcher(input.startAt, 'startAt');
  const startAfter = matcher(input.startAfter, 'startAfter');
  const endBefore = matcher(input.endBefore, 'endBefore');
  const endAfter = matcher(input.endAfter, 'endAfter');
  if (startAt && startAfter) throw new Error('startAt and startAfter are mutually exclusive');
  if (endBefore && endAfter) throw new Error('endBefore and endAfter are mutually exclusive');
  return {
    ...(hostname ? { hostname } : {}),
    includeSubdomains: input.includeSubdomains === true,
    pathPrefixes: Array.from(new Set(pathPrefixes.map((item) => String(item).trim()))),
    rootSelector: selector(input.rootSelector, 'rootSelector'),
    ...(startAt ? { startAt } : {}),
    ...(startAfter ? { startAfter } : {}),
    ...(endBefore ? { endBefore } : {}),
    ...(endAfter ? { endAfter } : {}),
    removeMatchers: removeInputs.map((item, index) => matcher(item, `removeMatchers[${index}]`)!),
  };
}

export async function extractionRuleHash(rule: FeedExtractionRuleConfig): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(rule));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function matchesUrl(rule: FeedExtractionRuleConfig, rawUrl: string): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  if (rule.hostname) {
    const host = url.hostname.toLowerCase();
    if (host !== rule.hostname && !(rule.includeSubdomains && host.endsWith(`.${rule.hostname}`))) return false;
  }
  return !rule.pathPrefixes?.length || rule.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix));
}

function find(root: Element, value: ExtractionNodeMatcher | undefined): Element[] {
  if (!value) return [];
  return Array.from(root.querySelectorAll(value.selector)).filter((element) => {
    if (value.textEquals !== undefined && normalizedText(element.textContent ?? '') !== normalizedText(value.textEquals)) return false;
    return !value.attributeEquals || element.getAttribute(value.attributeEquals.name) === value.attributeEquals.value;
  });
}

function trimBefore(root: Element, node: Element, include: boolean): void {
  let current: Element = node;
  let first = true;
  while (current !== root) {
    let sibling = current.previousSibling;
    while (sibling) { const previous = sibling.previousSibling; sibling.parentNode?.removeChild(sibling); sibling = previous; }
    const parent = current.parentElement;
    if (!parent) break;
    if (first && !include) current.remove();
    current = parent;
    first = false;
  }
}

function trimAfter(root: Element, node: Element, include: boolean): void {
  let current: Element = node;
  let first = true;
  while (current !== root) {
    let sibling = current.nextSibling;
    while (sibling) { const next = sibling.nextSibling; sibling.parentNode?.removeChild(sibling); sibling = next; }
    const parent = current.parentElement;
    if (!parent) break;
    if (first && !include) current.remove();
    current = parent;
    first = false;
  }
}

function readability(html: string, baseUrl: string, fallback = false, code: string | null = null): ExtractedArticleResult {
  return {
    html: extractReadableArticleHtml(html, baseUrl),
    strategy: fallback ? 'readability_fallback' : 'readability',
    diagnostics: { code, rootMatches: 0, startMatches: null, endMatches: null, removedNodes: 0 },
  };
}

export function extractArticleWithRule(rawHtml: string, baseUrl: string, configuredRule?: FeedExtractionRuleConfig | null): ExtractedArticleResult {
  if (!configuredRule) return readability(rawHtml, baseUrl);
  let rule: FeedExtractionRuleConfig;
  try { rule = validateFeedExtractionRule(configuredRule); } catch { return readability(rawHtml, baseUrl, true, 'invalid_rule'); }
  if (!matchesUrl(rule, baseUrl)) return readability(rawHtml, baseUrl, true, 'url_mismatch');
  try {
    const { document } = parseHTML(rawHtml);
    const roots = Array.from(document.querySelectorAll(rule.rootSelector));
    if (roots.length !== 1) {
      const result = readability(rawHtml, baseUrl, true, roots.length ? 'root_ambiguous' : 'root_missing');
      result.diagnostics.rootMatches = roots.length;
      return result;
    }
    const root = roots[0].cloneNode(true) as Element;
    const startMatcher = rule.startAt ?? rule.startAfter;
    const endMatcher = rule.endBefore ?? rule.endAfter;
    const starts = find(root, startMatcher);
    const ends = find(root, endMatcher);
    if (startMatcher && starts.length !== 1) {
      const result = readability(rawHtml, baseUrl, true, starts.length ? 'start_ambiguous' : 'start_missing');
      result.diagnostics = { ...result.diagnostics, rootMatches: 1, startMatches: starts.length, endMatches: endMatcher ? ends.length : null };
      return result;
    }
    if (endMatcher && ends.length !== 1) {
      const result = readability(rawHtml, baseUrl, true, ends.length ? 'end_ambiguous' : 'end_missing');
      result.diagnostics = { ...result.diagnostics, rootMatches: 1, startMatches: startMatcher ? starts.length : null, endMatches: ends.length };
      return result;
    }
    if (starts[0] && ends[0]) {
      const ordered = Array.from(root.querySelectorAll('*'));
      if (ordered.indexOf(starts[0]) > ordered.indexOf(ends[0])) {
        const result = readability(rawHtml, baseUrl, true, 'boundary_order_invalid');
        result.diagnostics = { ...result.diagnostics, rootMatches: 1, startMatches: 1, endMatches: 1 };
        return result;
      }
    }
    if (ends[0]) trimAfter(root, ends[0], Boolean(rule.endAfter));
    if (starts[0]) trimBefore(root, starts[0], Boolean(rule.startAt));
    let removedNodes = 0;
    for (const removeMatcher of rule.removeMatchers ?? []) {
      for (const element of find(root, removeMatcher)) { element.remove(); removedNodes++; }
    }
    const content = sanitizeArticleHtml(root.innerHTML, baseUrl);
    if (!stripHtml(content).trim()) {
      const result = readability(rawHtml, baseUrl, true, 'empty_rule_result');
      result.diagnostics = { ...result.diagnostics, rootMatches: 1, startMatches: startMatcher ? 1 : null, endMatches: endMatcher ? 1 : null, removedNodes };
      return result;
    }
    return { html: content, strategy: 'site_rule', diagnostics: {
      code: null, rootMatches: 1, startMatches: startMatcher ? 1 : null, endMatches: endMatcher ? 1 : null, removedNodes,
    } };
  } catch {
    return readability(rawHtml, baseUrl, true, 'rule_execution_failed');
  }
}

export function extractionPreviewSummary(result: ExtractedArticleResult) {
  const text = stripHtml(result.html);
  const blocks = htmlToBlocks(result.html);
  const headings = blocks.filter((block) => /^<h[1-6]\b/iu.test(block)).map((block) => stripHtml(block)).filter(Boolean);
  return {
    strategy: result.strategy,
    diagnosticCode: result.diagnostics.code,
    diagnostics: result.diagnostics,
    html: result.html,
    text,
    leadingText: Array.from(text).slice(0, 500).join(''),
    trailingText: Array.from(text).slice(-500).join(''),
    characterCount: Array.from(text).length,
    blockCount: blocks.length,
    headings,
  };
}
