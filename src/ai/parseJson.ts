const stripCodeFence = (value: string) => value
  .trim()
  .replace(/^```(?:json)?\s*/iu, '')
  .replace(/\s*```$/u, '');

const removeUnmatchedClosingBrackets = (value: string) => {
  const stack: string[] = [];
  const quote = String.fromCharCode(34);
  let output = '';
  let inString = false;
  let escaped = false;
  let changed = false;
  for (const char of value) {
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === quote) {
      inString = true;
      output += char;
    } else if (char === '{') {
      stack.push('}');
      output += char;
    } else if (char === '[') {
      stack.push(']');
      output += char;
    } else if (char === '}' || char === ']') {
      if (stack[stack.length - 1] === char) {
        stack.pop();
        output += char;
      } else changed = true;
    } else output += char;
  }
  return changed && !inString && stack.length === 0 ? output : null;
};

export const parseAiJsonResponse = (raw: string): unknown => {
  const normalized = stripCodeFence(raw);
  try {
    return JSON.parse(normalized);
  } catch {
    const repaired = removeUnmatchedClosingBrackets(normalized);
    if (repaired) {
      try { return JSON.parse(repaired); } catch { /* Use the stable error below. */ }
    }
    throw new Error('AI 服务商返回了无效 JSON。');
  }
};
