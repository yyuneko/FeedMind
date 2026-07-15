import katex from 'katex';
import { parseHTML } from 'linkedom';

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export const renderFormulaMarkup = (fragment: string) => {
  const { document } = parseHTML(`<body>${fragment}</body>`);
  const body = document.querySelector('body');
  if (!body) return fragment;
  for (const formula of Array.from(body.querySelectorAll('feedmind-math'))) {
    const source = formula.textContent?.trim() ?? '';
    const format = formula.getAttribute('data-format');
    const display = formula.getAttribute('data-display') === 'block';
    let markup = '';
    try {
      markup = format === 'mathml'
        ? source
        : katex.renderToString(source, {
          displayMode: display,
          output: 'mathml',
          strict: 'warn',
          throwOnError: true,
          trust: false,
        });
    } catch (error) {
      console.warn('Unable to render article formula', error);
      markup = `<code class="feedmind-formula-error">${escapeHtml(source)}</code>`;
    }
    const replacement = document.createElement(display ? 'div' : 'span');
    replacement.setAttribute('class', display ? 'feedmind-formula-block' : 'feedmind-formula-inline');
    replacement.innerHTML = markup;
    formula.replaceWith(replacement);
  }
  return body.innerHTML;
};

