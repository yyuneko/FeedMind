import hljs from "highlight.js/lib/common";

export type HighlightedCodeToken = {
  text: string;
  scopes: string[];
};

export type HighlightedCode = {
  language?: string;
  tokens: HighlightedCodeToken[][];
};

const decodeHtmlEntities = (value: string) =>
  value.replace(
    /&(amp|lt|gt|quot|#x27|#39);/g,
    (entity) =>
      ({
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&#x27;": "'",
        "&#39;": "'",
      }[entity] ?? entity)
  );

const tokensFromHtml = (html: string): HighlightedCodeToken[] => {
  const tokens: HighlightedCodeToken[] = [];
  const scopeStack: string[][] = [];
  const matcher = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(html))) {
    if (match[1]) {
      scopeStack.push(match[1].split(/\s+/).filter(Boolean));
    } else if (match[0] === "</span>") {
      scopeStack.pop();
    } else if (match[2]) {
      tokens.push({
        text: decodeHtmlEntities(match[2]),
        scopes: scopeStack.flat(),
      });
    }
  }

  return tokens;
};

export const highlightCode = (
  code: string,
  languageHint?: string
): HighlightedCode => {
  const hintedLanguage = languageHint?.trim().toLowerCase();
  const supportedHint =
    hintedLanguage && hljs.getLanguage(hintedLanguage)
      ? hintedLanguage
      : undefined;
  let result: { language?: string; value: string };
  try {
    result = supportedHint
      ? hljs.highlight(code, { language: supportedHint, ignoreIllegals: true })
      : hljs.highlightAuto(code);
  } catch {
    return {
      tokens: code
        .split("\n")
        .map((text) => (text ? [{ text, scopes: [] }] : [])),
    };
  }
  const lines: HighlightedCodeToken[][] = [[]];

  for (const token of tokensFromHtml(result.value)) {
    const parts = token.text.split("\n");
    parts.forEach((text, index) => {
      if (text) lines[lines.length - 1].push({ ...token, text });
      if (index < parts.length - 1) lines.push([]);
    });
  }

  return { language: supportedHint ?? result.language, tokens: lines };
};
