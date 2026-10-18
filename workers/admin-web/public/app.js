const state = { prompts: [], profiles: [], tasks: [], tags: [], articleTypes: [], configs: [], feeds: [], platformRules: [], parseProgress: [], extractionRule: null, extractionPreviews: new Map(), extractionSelected: new Set() };
const feedPagination = { limit: 20, offset: 0, hasMore: false, totalPages: 1 };
const parsePagination = { limit: 20, offset: 0, hasMore: false, totalPages: 1 };
const selectedParseIds = new Set();
const $ = (selector) => document.querySelector(selector);
const adminRoutes = new Map([
  ['/', { view: 'overview', title: '运行概览' }],
  ['/feeds', { view: 'feeds', title: '订阅源管理' }],
  ['/platform-rules', { view: 'platform-rules', title: '平台正文规则' }],
  ['/prompts', { view: 'prompts', title: '提示词版本' }],
  ['/ai-profiles', { view: 'profiles', title: 'AI Profiles' }],
  ['/topic-tags', { view: 'tags', title: '主题标签治理' }],
  ['/system-configuration', { view: 'configuration', title: '系统配置' }],
  ['/translation-tasks', { view: 'tasks', title: '翻译任务' }],
]);
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  hour12: false,
  timeZone: 'Asia/Shanghai',
});
const decodeHtmlText = (value) => {
  const text = String(value ?? '');
  if (!/&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/iu.test(text)) return text;
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return textarea.value;
};
const decodeArticleTitles = (value) => {
  if (Array.isArray(value)) return value.map(decodeArticleTitles);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    typeof item === 'string' && ['title', 'articleTitle', 'feedTitle', 'translatedTitle'].includes(key)
      ? decodeHtmlText(item)
      : decodeArticleTitles(item),
  ]));
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"/></svg>';
const formatDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTimeFormatter.format(date);
};
const notice = (message, error = false) => { const node = $('#notice'); node.textContent = message; node.style.background = error ? '#8c352d' : '#263b2e'; node.style.display = 'block'; clearTimeout(notice.timer); notice.timer = setTimeout(() => node.style.display = 'none', 4500); };

function openDialog(selector, initialize) {
  const dialog = $(selector);
  dialog.querySelectorAll('form').forEach((form) => form.reset());
  initialize?.(dialog);
  dialog.showModal();
}

function initializeProfileForm(profile = null) {
  const form = $('#profile-form');
  form.dataset.sourceId = profile?.id || '';
  form.dataset.profile = profile?.profile || '';
  form.elements.profile.disabled = Boolean(profile);
  $('#profile-dialog-title').textContent = profile ? `编辑 ${profile.profile} v${profile.version}` : '新建 Profile 版本';
  $('#profile-submit').textContent = profile ? '保存修改' : '保存草稿';
  if (!profile) return;
  form.elements.profile.value = profile.profile;
  form.elements.model.value = profile.model || '';
  form.elements.maxOutputTokens.value = profile.maxOutputTokens == null ? '' : String(profile.maxOutputTokens);
  form.elements.parameters.value = JSON.stringify(profile.parameters || {}, null, 2);
}

const Loading = (() => {
  const buttonStates = new WeakMap();
  const preservedNodes = new WeakSet();
  const nodes = (targets) => (Array.isArray(targets) ? targets : [targets]).map((target) => typeof target === 'string' ? $(target) : target).filter(Boolean);
  const markup = (message) => `<div class="loading" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>${escapeHtml(message)}</span></div>`;
  const finish = (node) => {
    node.removeAttribute('aria-busy');
    node.style.removeProperty('opacity');
    preservedNodes.delete(node);
  };
  return {
    show(targets, message = '加载中…') {
      nodes(targets).forEach((node) => {
        node.setAttribute('aria-busy', 'true');
        if (node.childNodes.length > 0) {
          preservedNodes.add(node);
          node.style.opacity = '0.65';
        } else {
          node.innerHTML = markup(message);
        }
      });
    },
    fail(targets, error) {
      nodes(targets).forEach((node) => {
        const preserved = preservedNodes.has(node);
        finish(node);
        if (!preserved) node.innerHTML = `<div class="empty loading-error">加载失败：${escapeHtml(error.message || error)}</div>`;
      });
    },
    async query(targets, task, message = '加载中…') {
      this.show(targets, message);
      try {
        const result = await task();
        nodes(targets).forEach(finish);
        return result;
      } catch (error) {
        this.fail(targets, error);
        throw error;
      }
    },
    async button(button, task, message = '处理中…') {
      if (!button) return task();
      if (buttonStates.has(button)) return;
      buttonStates.set(button, { disabled: button.disabled, html: button.innerHTML });
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.innerHTML = `<span class="button-loading-spinner" aria-hidden="true"></span><span>${escapeHtml(message)}</span>`;
      try {
        return await task();
      } finally {
        const original = buttonStates.get(button);
        if (original) {
          button.disabled = original.disabled;
          button.innerHTML = original.html;
          button.removeAttribute('aria-busy');
          buttonStates.delete(button);
        }
      }
    },
  };
})();

async function api(path, init = {}) {
  const response = await window.adminAuth.authorizedFetch(`/api${path}`, { ...init, headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `请求失败 (${response.status})`);
  return decodeArticleTitles(payload);
}

function badges(status) { return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status || '—')}</span>`; }
function empty(text) { return `<div class="empty">${escapeHtml(text)}</div>`; }

function renderModelSnapshot(title, config) {
  if (!config?.id) return `<section class="task-config-section"><h4>${escapeHtml(title)}</h4><p class="config-unavailable">版本快照不可用</p></section>`;
  const parameters = JSON.stringify(config.parameters || {}, null, 2);
  return `<section class="task-config-section"><h4>${escapeHtml(title)}</h4><dl class="config-grid"><div><dt>Profile 版本</dt><dd>${escapeHtml(config.profile)} v${escapeHtml(config.version)}</dd></div><div><dt>版本 ID</dt><dd>${escapeHtml(config.id)}</dd></div><div><dt>Provider</dt><dd>${escapeHtml(config.provider)}</dd></div><div><dt>Model</dt><dd>${escapeHtml(config.model)}</dd></div><div><dt>Protocol</dt><dd>${escapeHtml(config.protocol)}</dd></div><div><dt>最大输出 Token</dt><dd>${config.maxOutputTokens == null ? '不设上限' : escapeHtml(config.maxOutputTokens)}</dd></div><div><dt>Thinking</dt><dd>${config.thinkingEnabled ? '开启' : '关闭'}</dd></div><div><dt>Endpoint</dt><dd>${escapeHtml(config.endpoint)}</dd></div>${config.region ? `<div><dt>Region</dt><dd>${escapeHtml(config.region)}</dd></div>` : ''}${config.workspaceId ? `<div><dt>Workspace ID</dt><dd>${escapeHtml(config.workspaceId)}</dd></div>` : ''}</dl><div class="config-code-label">Parameters</div><pre class="config-code">${escapeHtml(parameters)}</pre></section>`;
}

function renderTaskConfiguration(task) {
  const prompt = task.prompt || {};
  const model = task.bodyModelConfig || {};
  const summary = `提示词 v${prompt.version ?? '—'} · ${model.provider || '未知 Provider'} / ${model.model || '未知模型'}`;
  return `<details class="task-configuration"><summary><span>执行时配置</span><small>${escapeHtml(summary)}</small></summary><div class="task-configuration-body"><section class="task-config-section"><h4>正文翻译提示词</h4><dl class="config-grid"><div><dt>版本</dt><dd>v${escapeHtml(prompt.version ?? '—')}</dd></div><div><dt>版本 ID</dt><dd>${escapeHtml(prompt.id || task.promptVersionId || '—')}</dd></div></dl>${prompt.content == null ? '<p class="config-unavailable">提示词版本快照不可用</p>' : `<pre class="config-code prompt-content">${escapeHtml(prompt.content)}</pre>`}</section>${renderModelSnapshot('正文翻译模型', task.bodyModelConfig)}${renderModelSnapshot('标题翻译模型', task.titleModelConfig)}</div></details>`;
}

function renderTaskDiagnostics(diagnostics) {
  if (!diagnostics?.length) return empty('该任务没有保存的大模型失败响应。');
  return diagnostics.map((item) => {
    let captured = null;
    try { captured = item.providerResponse ? JSON.parse(item.providerResponse) : null; } catch { /* Show the stored object verbatim below. */ }
    const response = captured?.responseBody ?? item.providerResponse;
    const status = captured?.responseStatus ?? '—';
    return `<article class="diagnostic-item"><div class="item-head"><div><h4>Attempt ${escapeHtml(item.attemptId)} · Batch ${escapeHtml(Number(item.batchIndex) + 1)}</h4><div class="meta"><span>${escapeHtml(item.failureStage)}</span><span>HTTP ${escapeHtml(status)}</span><time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(formatDateTime(item.createdAt))}</time></div></div><span class="badge failed">${escapeHtml(item.errorCode)}</span></div><div class="error-text">${escapeHtml(item.errorMessage)}</div><div class="config-code-label">大模型 API 原始响应</div>${response == null ? '<p class="config-unavailable">R2 中的响应对象不可用</p>' : `<pre class="config-code diagnostic-response">${escapeHtml(response)}</pre>`}</article>`;
  }).join('');
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('浏览器不允许访问剪贴板');
}

function normalizedPathname() {
  const pathname = window.location.pathname.replace(/\/+$/, '');
  return pathname || '/';
}

function renderRoute(pathname = normalizedPathname(), replaceInvalid = true) {
  const route = adminRoutes.get(pathname);
  if (!route) {
    if (replaceInvalid) window.history.replaceState({}, '', '/');
    return renderRoute('/', false);
  }
  document.querySelectorAll('[data-view],.view').forEach((node) => node.classList.remove('active'));
  const navButton = document.querySelector(`[data-view="${route.view}"]`);
  navButton?.classList.add('active');
  navButton?.setAttribute('aria-current', 'page');
  document.querySelectorAll('[data-view]:not(.active)').forEach((node) => node.removeAttribute('aria-current'));
  $(`#${route.view}`).classList.add('active');
  document.title = `${route.title} · FeedMind 管理台`;
}

function navigate(pathname) {
  if (normalizedPathname() !== pathname) window.history.pushState({}, '', pathname);
  renderRoute(pathname);
  void loadRoute(pathname);
}

async function fetchFeeds() {
  const params = new URLSearchParams(new FormData($('#feed-filter-form')));
  params.set('limit', String(feedPagination.limit));
  params.set('offset', String(feedPagination.offset));
  const payload = await api(`/admin/v1/feeds?${params}`);
  state.feeds = payload.items || [];
  feedPagination.hasMore = Boolean(payload.hasMore);
  feedPagination.totalPages = Math.max(1, Number(payload.totalPages) || 1);
  $('#feed-list').innerHTML = state.feeds.length ? state.feeds.map((feed) => {
    const external = feed.connectorType !== 'direct_rss';
    return `<article class="item feed-item" data-feed-open="${feed.id}" tabindex="0" role="button" aria-label="查看 ${escapeHtml(feed.title)} 的文章解析进度"><div class="feed-main"><h3 title="${escapeHtml(feed.title)}">${escapeHtml(feed.title)}</h3><div class="meta"><span>${external ? 'FreshRSS' : 'Direct RSS'}</span><span>${escapeHtml(feed.category || '未分类')}</span><span>${escapeHtml(feed.articleCount)} 篇</span><span>等待 ${escapeHtml(feed.pendingCount)}</span><span>解析中 ${escapeHtml(feed.runningCount)}</span><span>成功 ${escapeHtml(feed.completedCount)}</span>${Number(feed.failedCount) ? `<span class="compact-error">失败 ${escapeHtml(feed.failedCount)}</span>` : ''}<time datetime="${escapeHtml(feed.lastFetchedAt)}">${escapeHtml(formatDateTime(feed.lastFetchedAt))}</time></div><div class="url-row"><p class="item-url" title="${escapeHtml(feed.url)}">${escapeHtml(feed.url || '由上游提供')}</p>${feed.url ? `<button type="button" class="copy-button" data-copy="${escapeHtml(feed.url)}" title="复制订阅源 URL" aria-label="复制订阅源 URL">${copyIcon}</button>` : ''}</div>${feed.lastErrorCode ? `<div class="error-text compact-error-line" title="${escapeHtml(feed.lastErrorCode)}">${escapeHtml(feed.lastErrorCode)}</div>` : ''}</div><div class="feed-side">${badges(feed.fetchStatus)}<button data-feed-name-edit="${feed.id}" class="ghost">修改名称</button>${external ? '' : `<button data-rule-open="${feed.id}" class="ghost">正文规则</button>`}<button data-feed-refresh="${feed.id}" ${feed.fetchStatus === 'running' ? 'disabled' : ''}>${external ? '立即同步' : '立即抓取'}</button>${!external && Number(feed.subscriberCount) === 0 ? `<button class="danger" data-feed-delete="${feed.id}" data-feed-title="${escapeHtml(feed.title)}">删除</button>` : ''}</div></article>`;
  }).join('') : empty('没有符合条件的订阅源。');
  const currentPage = Math.floor(feedPagination.offset / feedPagination.limit) + 1;
  $('#feed-page').textContent = `第 ${currentPage} / ${feedPagination.totalPages} 页`;
  $('#feed-prev').hidden = currentPage <= 1;
  $('#feed-next').hidden = !feedPagination.hasMore;
}

async function fetchPlatformRules() {
  const payload = await api('/admin/v1/platform-extraction-rules');
  state.platformRules = payload.items || [];
  $('#platform-rule-list').innerHTML = state.platformRules.length ? state.platformRules.map((item) => {
    const paths = item.rule?.pathPrefixes?.length ? item.rule.pathPrefixes.join('、') : '全部路径';
    return `<article class="item"><div class="item-head"><div><h3>${escapeHtml(item.name)}</h3><div class="meta"><span>Playwright</span><span>${escapeHtml(item.rule?.hostname || item.hostname)}</span><span>${item.rule?.includeSubdomains ? '包含子域名' : '仅此域名'}</span><span>${escapeHtml(paths)}</span><time datetime="${escapeHtml(item.updatedAt)}">${escapeHtml(formatDateTime(item.updatedAt))}</time></div><p class="item-url">正文根：${escapeHtml(item.rule?.rootSelector || '—')}</p></div>${badges(item.isEnabled ? 'enabled' : 'disabled')}</div><div class="row-actions"><button class="ghost" data-platform-rule-edit="${item.id}">编辑</button><button class="danger" data-platform-rule-delete="${item.id}" data-platform-rule-name="${escapeHtml(item.name)}">删除</button></div></article>`;
  }).join('') : empty('尚未配置平台正文规则。');
}

function openPlatformRuleDialog(item = null) {
  openDialog('#platform-rule-dialog', () => {
    const form = $('#platform-rule-form');
    form.dataset.id = item?.id || '';
    $('#platform-rule-dialog-title').textContent = item ? `编辑 ${item.name}` : '新增平台正文规则';
    form.elements.isEnabled.checked = item ? Boolean(item.isEnabled) : true;
    if (!item) return;
    form.elements.name.value = item.name || '';
    fillExtractionRuleForm(item.rule || {}, '', form);
  });
}

async function fetchParseProgress() {
  const params = new URLSearchParams(new FormData($('#parse-filter-form')));
  params.set('limit', String(parsePagination.limit));
  params.set('offset', String(parsePagination.offset));
  const payload = await api(`/admin/v1/article-parse-progress?${params}`);
  state.parseProgress = payload.items || [];
  selectedParseIds.clear();
  parsePagination.hasMore = Boolean(payload.hasMore);
  parsePagination.totalPages = Math.max(1, Number(payload.totalPages) || 1);
  $('#parse-list').innerHTML = state.parseProgress.length ? state.parseProgress.map((item) => {
    const preprocessingStatus = item.preprocessingStatus || 'missing';
    const preprocessingLabel = ({
      completed: 'AI 预处理成功', pending: '等待 AI 预处理', running: 'AI 预处理中',
      failed: 'AI 预处理失败', content_too_large: '正文超出模型上下文', blocked: '等待正文解析', missing: '尚未 AI 预处理',
    })[preprocessingStatus] || '尚未 AI 预处理';
    const preprocessingStatusClass = preprocessingStatus === 'completed'
      ? 'completed' : ['failed', 'content_too_large'].includes(preprocessingStatus) ? 'failed' : 'pending';
    const preprocessingMarkup = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:9px"><span class="badge ${preprocessingStatusClass}">${escapeHtml(preprocessingLabel)}</span></div>`;
    const topicTags = Array.isArray(item.topicTags) ? item.topicTags : [];
    const topicTagsMarkup = topicTags.length
      ? `<div class="article-topic-tags" aria-label="文章主题">${topicTags.map((tag) => `<span class="article-topic-tag" title="${escapeHtml(tag.key || tag.name)}">#${escapeHtml(tag.name || tag.key)}</span>`).join('')}</div>` : '';
    const preprocessingError = preprocessingStatus !== 'completed' && (item.preprocessingErrorMessage || item.preprocessingErrorCode)
      ? `<div class="error-text compact-error-line" title="${escapeHtml(item.preprocessingErrorMessage || item.preprocessingErrorCode)}">${escapeHtml(item.preprocessingErrorCode || 'preprocessing_failed')}: ${escapeHtml(item.preprocessingErrorMessage || '')}</div>` : '';
    const diagnostic = item.preprocessingDiagnostic;
    const preprocessingDiagnostic = ['failed', 'content_too_large'].includes(preprocessingStatus)
      ? `<details class="preprocessing-diagnostic"><summary>查看大模型输入和输出</summary><div class="preprocessing-diagnostic-body"><div class="config-code-label">大模型输入 · System</div>${diagnostic?.input?.system ? `<pre class="config-code">${escapeHtml(diagnostic.input.system)}</pre>` : '<p class="config-unavailable">输入不可用</p>'}<div class="config-code-label">大模型输入 · User</div>${diagnostic?.input?.user ? `<pre class="config-code">${escapeHtml(diagnostic.input.user)}</pre>` : '<p class="config-unavailable">输入不可用</p>'}<div class="config-code-label">大模型输出${diagnostic?.responseStatus != null ? ` · HTTP ${escapeHtml(diagnostic.responseStatus)}` : ''}</div>${diagnostic?.output ? `<pre class="config-code diagnostic-response">${escapeHtml(diagnostic.output)}</pre>` : '<p class="config-unavailable">大模型未返回输出</p>'}</div></details>` : '';
    return `<article class="item parse-item"><div style="display:flex;align-items:flex-start;gap:11px;min-width:0"><input type="checkbox" data-parse-select="${item.id}" aria-label="选择 ${escapeHtml(item.title || item.url)}" style="width:auto;padding:0;margin-top:4px;flex:none"><div class="parse-main"><h3 title="${escapeHtml(item.title || item.url)}">${escapeHtml(item.title || item.url)}</h3><div class="meta"><span>${escapeHtml(item.feedTitle || '未知订阅源')}</span><span>解析器 v${escapeHtml(item.parserVersion || '—')}</span><span>提取 ${escapeHtml(item.extractionStrategy || 'readability')}${item.extractionDiagnosticCode ? ` · ${escapeHtml(item.extractionDiagnosticCode)}` : ''}</span><span>尝试 ${escapeHtml(item.attemptCount || 0)}</span><time datetime="${escapeHtml(item.updatedAt)}">${escapeHtml(formatDateTime(item.updatedAt))}</time></div><div class="url-row"><p class="item-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</p><button type="button" class="copy-button" data-copy="${escapeHtml(item.url)}" title="复制文章 URL" aria-label="复制文章 URL">${copyIcon}</button></div>${preprocessingMarkup}${topicTagsMarkup}${preprocessingError}${preprocessingDiagnostic}${item.parseError || item.errorMessage ? `<div class="error-text compact-error-line" title="${escapeHtml(item.errorMessage || item.parseError)}">${escapeHtml(item.errorCode || 'parse_failed')}: ${escapeHtml(item.errorMessage || item.parseError)}</div>` : ''}</div></div><div class="parse-side">${badges(item.parseStatus)}${item.parseStatus === 'failed' ? `<button data-parse-action="parse-retry" data-id="${item.id}">重试正文解析</button>` : ''}${item.parseStatus === 'completed' ? `<button data-parse-action="reparse" data-id="${item.id}" class="ghost">正文解析</button><button data-parse-action="reclassify" data-id="${item.id}">AI 全文预处理</button>` : ''}</div></article>`;
  }).join('') : empty('没有符合条件的文章解析记录。');
  const currentPage = Math.floor(parsePagination.offset / parsePagination.limit) + 1;
  $('#parse-page').textContent = `第 ${currentPage} / ${parsePagination.totalPages} 页`;
  $('#parse-prev').hidden = currentPage <= 1;
  $('#parse-next').hidden = !parsePagination.hasMore;
  updateParseBulkControls();
}

function eligibleParseItems(action) {
  return state.parseProgress.filter((item) => selectedParseIds.has(item.id) && (
    action === 'parse-retry' ? item.parseStatus === 'failed'
      : action === 'reparse' ? item.parseStatus === 'completed'
        : action === 'reclassify' ? item.parseStatus === 'completed' : false
  ));
}

function updateParseBulkControls() {
  const visibleIds = state.parseProgress.map((item) => item.id);
  const selectedCount = visibleIds.filter((id) => selectedParseIds.has(id)).length;
  $('#parse-selection-count').textContent = `已选择 ${selectedCount} 篇`;
  const selectAll = $('#parse-select-all');
  selectAll.checked = visibleIds.length > 0 && selectedCount === visibleIds.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < visibleIds.length;
  selectAll.disabled = visibleIds.length === 0;
  document.querySelectorAll('[data-bulk-parse-action]').forEach((button) => {
    button.disabled = eligibleParseItems(button.dataset.bulkParseAction).length === 0;
  });
}

async function settleInBatches(items, batchSize, operation) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    results.push(...await Promise.allSettled(items.slice(index, index + batchSize).map(operation)));
  }
  return results;
}

function attributeMatcher(value) {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const separator = raw.indexOf('=');
  if (separator < 1) throw new Error('属性条件必须使用 name=value 格式');
  return { name: raw.slice(0, separator).trim(), value: raw.slice(separator + 1).trim() };
}

function boundaryFromForm(form, prefix) {
  const mode = form.elements[`${prefix}Mode`].value;
  if (!mode) return {};
  const selector = form.elements[`${prefix}Selector`].value.trim();
  if (!selector) throw new Error(`${prefix === 'start' ? '起始' : '结束'}边界需要 CSS Selector`);
  const textEquals = form.elements[`${prefix}Text`].value.trim();
  const attributeEquals = attributeMatcher(form.elements[`${prefix}Attribute`].value);
  return { [mode]: { selector, ...(textEquals ? { textEquals } : {}), ...(attributeEquals ? { attributeEquals } : {}) } };
}

function extractionRuleFromForm(form = $('#extraction-rule-form')) {
  const lines = (name) => form.elements[name].value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return {
    ...(form.elements.hostname.value.trim() ? { hostname: form.elements.hostname.value.trim() } : {}),
    includeSubdomains: form.elements.includeSubdomains.checked,
    pathPrefixes: lines('pathPrefixes'),
    rootSelector: form.elements.rootSelector.value.trim(),
    ...boundaryFromForm(form, 'start'),
    ...boundaryFromForm(form, 'end'),
    removeMatchers: lines('removeSelectors').map((selector) => ({ selector })),
  };
}

function matcherAttribute(matcher) {
  return matcher?.attributeEquals ? `${matcher.attributeEquals.name}=${matcher.attributeEquals.value}` : '';
}

function fillExtractionRuleForm(rule, changeNote = '', form = $('#extraction-rule-form')) {
  form.elements.hostname.value = rule?.hostname || '';
  form.elements.includeSubdomains.checked = Boolean(rule?.includeSubdomains);
  form.elements.pathPrefixes.value = (rule?.pathPrefixes || []).join('\n');
  form.elements.rootSelector.value = rule?.rootSelector || '';
  const startMode = rule?.startAt ? 'startAt' : rule?.startAfter ? 'startAfter' : '';
  const start = rule?.startAt || rule?.startAfter;
  form.elements.startMode.value = startMode;
  form.elements.startSelector.value = start?.selector || '';
  form.elements.startText.value = start?.textEquals || '';
  form.elements.startAttribute.value = matcherAttribute(start);
  const endMode = rule?.endBefore ? 'endBefore' : rule?.endAfter ? 'endAfter' : '';
  const end = rule?.endBefore || rule?.endAfter;
  form.elements.endMode.value = endMode;
  form.elements.endSelector.value = end?.selector || '';
  form.elements.endText.value = end?.textEquals || '';
  form.elements.endAttribute.value = matcherAttribute(end);
  form.elements.removeSelectors.value = (rule?.removeMatchers || []).map((item) => item.selector).join('\n');
  if (form.elements.changeNote) form.elements.changeNote.value = changeNote || '';
}

function previewColumn(title, result) {
  return `<section class="preview-column"><div class="item-head"><h4>${escapeHtml(title)}</h4>${badges(result.strategy)}</div><div class="meta"><span>${escapeHtml(result.blockCount)} 块</span><span>${escapeHtml(result.characterCount)} 字符</span><span>裁剪 ${escapeHtml(result.diagnostics?.removedNodes || 0)} 个节点</span>${result.diagnosticCode ? `<span class="compact-error">${escapeHtml(result.diagnosticCode)}</span>` : ''}</div><details><summary>首尾文本与标题</summary><p class="preview-text">${escapeHtml(result.leadingText)}</p><p class="preview-text">… ${escapeHtml(result.trailingText)}</p><div class="meta">${(result.headings || []).map((heading) => `<span>${escapeHtml(heading)}</span>`).join('')}</div></details><iframe sandbox="" title="${escapeHtml(title)}" data-preview-html="${escapeHtml(title)}"></iframe></section>`;
}

function renderExtractionRule() {
  const data = state.extractionRule;
  if (!data) return;
  const confirmed = new Set((data.validations || []).map((item) => item.articleId));
  $('#extraction-rule-heading').textContent = `${data.feed.title} · 正文规则`;
  const selected = state.extractionSelected;
  const selectedConfirmed = Array.from(selected).filter((id) => confirmed.has(id)).length;
  $('#extraction-rule-status').innerHTML = `<div class="meta"><span>活动版本：${data.active ? `v${escapeHtml(data.active.version)}` : '无'}</span><span>草稿：${data.draft ? `v${escapeHtml(data.draft.version)}` : '无'}</span><span>样本确认（可选）：${selectedConfirmed}/${selected.size}</span><span>发布无需样本确认</span><span>可用文章：${escapeHtml(data.availableCount)}</span></div>`;
  $('#extraction-samples').innerHTML = data.samples.length ? data.samples.map((sample, index) => {
    const preview = state.extractionPreviews.get(sample.id);
    return `<article class="item rule-sample"><div class="item-head"><div style="display:flex;align-items:flex-start;gap:9px"><input type="checkbox" data-rule-sample-select="${sample.id}" ${selected.has(sample.id) ? 'checked' : ''} aria-label="选择验证样本"><div><h3>${escapeHtml(sample.title || sample.url)}</h3><p class="item-url">${escapeHtml(sample.url)}</p></div></div>${confirmed.has(sample.id) ? badges('confirmed') : index < 3 ? badges('recommended') : ''}</div><div class="row-actions"><button type="button" data-rule-preview="${sample.id}" ${data.draft ? '' : 'disabled'}>实时预览</button>${preview ? `<button type="button" data-rule-confirm="${sample.id}" class="ghost" ${confirmed.has(sample.id) ? 'disabled' : ''}>${confirmed.has(sample.id) ? '已确认' : '确认此样本'}</button>` : ''}</div>${preview ? `<div class="preview-grid">${previewColumn('当前线上提取', preview.current)}${previewColumn('草稿提取', preview.candidate)}</div>` : ''}</article>`;
  }).join('') : empty('该订阅源没有可预览的已解析文章。');
  for (const sample of data.samples) {
    const preview = state.extractionPreviews.get(sample.id);
    if (!preview) continue;
    const card = document.querySelector(`[data-rule-preview="${CSS.escape(sample.id)}"]`)?.closest('.rule-sample');
    const frames = card?.querySelectorAll('iframe[data-preview-html]') || [];
    if (frames[0]) frames[0].srcdoc = preview.current.html;
    if (frames[1]) frames[1].srcdoc = preview.candidate.html;
  }
  $('#extraction-rule-history').innerHTML = data.versions.length ? data.versions.map((version) => `<article class="item"><div class="item-head"><div><h3>v${escapeHtml(version.version)}</h3><div class="meta"><span>${escapeHtml(version.createdByEmail)}</span><span>${escapeHtml(version.changeNote || '无说明')}</span><time>${escapeHtml(formatDateTime(version.createdAt))}</time></div></div>${badges(version.status)}</div>${version.status === 'archived' ? `<div class="row-actions"><button type="button" class="ghost" data-rule-rollback="${version.id}">回滚为活动版本</button></div>` : ''}</article>`).join('') : empty('尚未保存规则版本。');
  $('[data-rule-publish]').disabled = !data.draft;
  $('[data-rule-abandon]').disabled = !data.draft;
}

async function loadExtractionRule(feedId, initialize = false) {
  const payload = await api(`/admin/v1/feeds/${encodeURIComponent(feedId)}/extraction-rule`);
  state.extractionRule = { ...payload.data, feedId };
  state.extractionPreviews.clear();
  if (initialize) {
    state.extractionSelected = new Set();
    const source = payload.data.draft || payload.data.active;
    fillExtractionRuleForm(source?.rule || {}, source?.changeNote || '');
  }
  renderExtractionRule();
}

async function openExtractionRule(feedId) {
  openDialog('#extraction-rule-dialog', () => {
    state.extractionRule = null;
    state.extractionPreviews.clear();
    state.extractionSelected.clear();
    $('#extraction-rule-heading').textContent = '正在加载正文规则…';
    $('#extraction-rule-status').innerHTML = '';
    $('#extraction-samples').innerHTML = '';
    $('#extraction-rule-history').innerHTML = '';
  });
  try { await Loading.query(['#extraction-samples', '#extraction-rule-history'], () => loadExtractionRule(feedId, true), '正在加载规则与样本…'); }
  catch (error) { notice(error.message, true); }
}

async function fetchPrompts() {
  state.prompts = (await api('/admin/v1/prompts')).items || [];
  $('#prompt-list').innerHTML = state.prompts.length ? state.prompts.map((p) => `<article class="item"><div class="item-head"><div><h3>${escapeHtml(p.task)} · ${escapeHtml(p.articleType || 'global')} · ${escapeHtml(p.targetLocale)}</h3><div class="meta"><span>版本 ${escapeHtml(p.currentVersion || '未发布')}</span><time datetime="${escapeHtml(p.updatedAt)}">${escapeHtml(formatDateTime(p.updatedAt))}</time></div></div>${badges(p.status)}</div><div class="row-actions"><button data-prompt-action="versions" data-id="${p.id}" class="ghost">版本</button><button data-prompt-action="edit" data-id="${p.id}" class="ghost">编辑</button><button data-prompt-action="test" data-id="${p.id}" class="ghost">测试</button><button data-prompt-action="delete" data-id="${p.id}" class="danger">删除</button></div><div id="versions-${p.id}"></div></article>`).join('') : empty('尚未创建提示词。');
}

async function fetchProfiles() {
  state.profiles = (await api('/admin/v1/ai-profiles')).items || [];
  $('#profile-list').innerHTML = state.profiles.length ? state.profiles.map((p) => `<article class="item"><div class="item-head"><div><h3>${escapeHtml(p.profile)} v${escapeHtml(p.version)} · ${escapeHtml(p.provider)}</h3><div class="meta"><span>${escapeHtml(p.model)}</span><span>${escapeHtml(p.endpoint)}</span><span>上下文 ${p.contextWindowTokens ? escapeHtml(p.contextWindowTokens) : '未同步'}</span><span>max ${p.maxOutputTokens == null ? '不设上限' : escapeHtml(p.maxOutputTokens)}</span></div></div>${badges(p.status)}</div><div class="row-actions"><button data-profile-action="edit" data-id="${p.id}" class="ghost">编辑</button><button data-profile-action="test" data-id="${p.id}" class="ghost">连通测试</button>${p.status !== 'active' ? `<button data-profile-action="publish" data-id="${p.id}">测试并发布</button>` : ''}<button data-profile-action="delete" data-id="${p.id}" class="danger">删除</button></div></article>`).join('') : empty('尚未创建 AI Profile。请先配置 OPENROUTER_API_KEY。');
}

async function fetchTasks() {
  state.tasks = (await api('/admin/v1/translations')).items || [];
  $('#task-list').innerHTML = state.tasks.length ? state.tasks.map((t) => `<article class="item"><div class="item-head"><div><h3>${escapeHtml(t.articleTitle || t.articleId)}</h3><div class="meta"><span>${escapeHtml(t.articleType)} → ${escapeHtml(t.targetLocale)}</span><time datetime="${escapeHtml(t.createdAt)}">${escapeHtml(formatDateTime(t.createdAt))}</time><span>重试 ${escapeHtml(t.retryCount)}</span></div></div>${badges(t.status)}</div>${t.errorMessage ? `<div class="error-text">${escapeHtml(t.errorCode)}: ${escapeHtml(t.errorMessage)}</div>` : ''}${renderTaskConfiguration(t)}<div class="row-actions">${Number(t.diagnosticCount) ? `<button data-task-diagnostics="${t.id}" class="diagnostic-button">查看失败响应 (${escapeHtml(t.diagnosticCount)})</button>` : ''}${['failed', 'cancelled', 'superseded'].includes(t.status) ? `<button data-task-action="retry" data-id="${t.id}">重试</button>` : ''}${['pending', 'running', 'cancel_requested'].includes(t.status) ? `<button data-task-action="cancel" data-id="${t.id}" class="ghost">取消</button>` : ''}${t.status !== 'completed' && t.workflowInstanceId ? `<button data-task-action="restart" data-id="${t.id}" class="ghost">重启工作流</button>` : ''}<button data-article-action="retranslate" data-id="${t.articleId}" data-parent="${t.id}" class="ghost">使用新配置重翻</button><button data-article-action="reclassify" data-id="${t.articleId}" class="ghost">重新分类</button><button data-article-action="reparse" data-id="${t.articleId}" class="ghost">重新解析</button></div><div id="diagnostics-${t.id}" class="diagnostic-list"></div></article>`).join('') : empty('暂无翻译任务。');
}

async function fetchConfiguration() {
  const [types, configs] = await Promise.all([api('/admin/v1/article-types'), api('/admin/v1/system-configs')]);
  state.articleTypes = types.items || []; state.configs = configs.items || [];
  $('#article-type-list').innerHTML = state.articleTypes.map((item) => `<article class="item"><div class="item-head"><div><h3>${escapeHtml(item.displayName)} · ${escapeHtml(item.key)}</h3><p>${escapeHtml(item.description)}</p></div>${badges(item.isEnabled ? 'enabled' : 'disabled')}</div><div class="row-actions"><button class="ghost" data-type-edit="${item.key}">编辑说明</button><button class="${item.isEnabled ? 'danger' : 'ghost'}" data-type-toggle="${item.key}" data-enabled="${item.isEnabled}">${item.isEnabled ? '禁用' : '启用'}</button></div></article>`).join('');
  $('#config-list').innerHTML = state.configs.map((item) => `<article class="item"><div class="item-head"><div><h3>${escapeHtml(item.configKey)} · v${item.version}</h3><pre>${escapeHtml(JSON.stringify(item.value, null, 2))}</pre></div>${badges(item.status)}</div><div class="row-actions">${item.status === 'active' ? `<button class="ghost" data-config-edit="${item.configKey}">发布新版本</button>` : ''}<button class="danger" data-config-delete="${item.id}" data-config-label="${escapeHtml(item.configKey)} v${item.version}">删除</button></div></article>`).join('') || empty('暂无系统配置。');
}

async function fetchTopicTags() {
  state.tags = (await api('/admin/v1/topic-tags')).items || [];
  $('#tag-list').innerHTML = state.tags.length ? state.tags.map((tag) => `<article class="item"><div class="item-head"><div><h3>${escapeHtml(tag.names?.['zh-CN'] || tag.key)} · ${escapeHtml(tag.key)}</h3><div class="meta"><span>${escapeHtml(tag.names?.['en-US'] || '')}</span><span>${escapeHtml(tag.names?.['ja-JP'] || '')}</span><span>词表 v${escapeHtml(tag.vocabularyVersion)}</span></div></div>${badges(tag.status)}</div><div class="row-actions">${tag.status === 'deprecated' ? `<button data-tag-status="active" data-id="${tag.id}">重新启用</button>` : `<button class="danger" data-tag-status="deprecated" data-id="${tag.id}">弃用</button>`}</div></article>`).join('') : empty('暂无主题标签。');
}

function renderMetrics() {
  const activeProfiles = state.profiles.filter((x) => x.status === 'active').length;
  const activeTasks = state.tasks.filter((x) => ['pending', 'running', 'cancel_requested'].includes(x.status)).length;
  $('#metrics').innerHTML = `<div class="metric"><span>有效提示词</span><strong>${state.prompts.filter((x) => !x.deletedAt).length}</strong></div><div class="metric"><span>激活 AI Profiles</span><strong>${activeProfiles}/2</strong></div><div class="metric"><span>进行中翻译</span><strong>${activeTasks}</strong></div>`;
}

const loadFeeds = () => Loading.query('#feed-list', fetchFeeds, '正在查询订阅源…');
const loadPlatformRules = () => Loading.query('#platform-rule-list', fetchPlatformRules, '正在查询平台规则…');
const loadParseProgress = () => Loading.query('#parse-list', fetchParseProgress, '正在查询解析进度…');
const loadPrompts = () => Loading.query('#prompt-list', fetchPrompts, '正在查询提示词…');
const loadProfiles = () => Loading.query('#profile-list', fetchProfiles, '正在查询 AI Profiles…');
const loadTags = () => Loading.query('#tag-list', fetchTopicTags, '正在查询主题标签…');
const loadTasks = () => Loading.query('#task-list', fetchTasks, '正在查询翻译任务…');
const loadConfiguration = () => Loading.query(['#article-type-list', '#config-list'], fetchConfiguration, '正在查询系统配置…');

async function loadAll() { try { await Loading.query('#metrics', async () => { await Promise.all([loadPrompts(), loadProfiles(), loadTasks(), loadConfiguration(), loadFeeds()]); renderMetrics(); }, '正在加载概览…'); } catch (error) { notice(error.message, true); } }

async function loadRoute(pathname = normalizedPathname()) {
  const route = adminRoutes.get(pathname) || adminRoutes.get('/');
  const loader = {
    overview: loadAll,
    feeds: loadFeeds,
    'platform-rules': loadPlatformRules,
    prompts: loadPrompts,
    profiles: loadProfiles,
    tags: loadTags,
    configuration: loadConfiguration,
    tasks: loadTasks,
  }[route.view];
  try {
    await loader();
  } catch (error) {
    notice(error.message, true);
  }
}

$('#nav').addEventListener('click', (event) => { const button = event.target.closest('[data-route]'); if (!button) return; navigate(button.dataset.route); });
window.addEventListener('popstate', () => {
  renderRoute();
  void loadRoute();
});
async function handleAdminClick(event) {
  const profileBackfill = event.target.closest('[data-profile-backfill]'); if (profileBackfill) try {
    const result = await api('/admin/v1/ai-profiles/backfill-metadata', { method: 'POST', body: JSON.stringify({}) });
    notice(`已同步 ${result.data?.updated || 0} 个 Profile`); await loadProfiles();
  } catch (error) { notice(error.message, true); }
  const modal = event.target.closest('[data-modal]'); if (modal) return openDialog(`#${modal.dataset.modal}-dialog`, modal.dataset.modal === 'profile' ? () => initializeProfileForm() : undefined);
  const platformRuleNew = event.target.closest('[data-platform-rule-new]'); if (platformRuleNew) return openPlatformRuleDialog();
  const platformRuleEdit = event.target.closest('[data-platform-rule-edit]'); if (platformRuleEdit) {
    const item = state.platformRules.find((candidate) => candidate.id === platformRuleEdit.dataset.platformRuleEdit);
    if (item) return openPlatformRuleDialog(item);
  }
  const platformRuleDelete = event.target.closest('[data-platform-rule-delete]'); if (platformRuleDelete) {
    if (!confirm(`确定删除平台正文规则“${platformRuleDelete.dataset.platformRuleName}”？已有文章不会自动重解析。`)) return;
    try {
      await api(`/admin/v1/platform-extraction-rules/${encodeURIComponent(platformRuleDelete.dataset.platformRuleDelete)}`, { method: 'DELETE' });
      notice('平台正文规则已删除');
      await loadPlatformRules();
    } catch (error) { notice(error.message, true); }
    return;
  }
  const closeDialog = event.target.closest('[data-dialog-close]'); if (closeDialog) return closeDialog.closest('dialog').close('cancel');
  const refresh = event.target.closest('[data-refresh]'); if (refresh) return refresh.dataset.refresh === 'all' ? loadAll() : ({ tasks: loadTasks, configuration: loadConfiguration, feeds: loadFeeds, tags: loadTags }[refresh.dataset.refresh]?.());
  const tagStatus = event.target.closest('[data-tag-status]'); if (tagStatus) try {
    const tag = state.tags.find((item) => item.id === tagStatus.dataset.id);
    await api(`/admin/v1/topic-tags/${encodeURIComponent(tag.id)}`, { method: 'PATCH', body: JSON.stringify({ status: tagStatus.dataset.tagStatus, names: tag.names, aliases: tag.aliases || [] }) });
    notice(tagStatus.dataset.tagStatus === 'active' ? '标签已启用' : '标签已弃用'); await loadTags();
  } catch (error) { notice(error.message, true); }
  const refreshParse = event.target.closest('[data-refresh-parse]'); if (refreshParse) return loadParseProgress();
  const copyButton = event.target.closest('[data-copy]'); if (copyButton) {
    try { await copyText(copyButton.dataset.copy); notice('URL 已复制'); } catch (error) { notice(error.message, true); }
    return;
  }
  const feedNameEdit = event.target.closest('[data-feed-name-edit]'); if (feedNameEdit) {
    const feed = state.feeds.find((item) => item.id === feedNameEdit.dataset.feedNameEdit);
    if (feed) openDialog('#feed-name-dialog', () => {
      const form = $('#feed-name-form');
      form.dataset.id = feed.id;
      form.elements.title.value = feed.title || '';
    });
    return;
  }
  const ruleOpen = event.target.closest('[data-rule-open]'); if (ruleOpen) return openExtractionRule(ruleOpen.dataset.ruleOpen);
  const ruleSampleReset = event.target.closest('[data-rule-sample-reset]'); if (ruleSampleReset) try {
    $('#extraction-sample-search').reset();
    const payload = await api(`/admin/v1/feeds/${encodeURIComponent(state.extractionRule.feedId)}/extraction-rule/samples`);
    state.extractionRule.samples = payload.items || [];
    state.extractionPreviews.clear();
    renderExtractionRule();
  } catch (error) { notice(error.message, true); }
  const rulePreview = event.target.closest('[data-rule-preview]'); if (rulePreview) try {
    const payload = await api(`/admin/v1/feeds/${encodeURIComponent(state.extractionRule.feedId)}/extraction-rule/preview`, {
      method: 'POST', body: JSON.stringify({ articleId: rulePreview.dataset.rulePreview }),
    });
    state.extractionPreviews.set(rulePreview.dataset.rulePreview, payload.data);
    renderExtractionRule();
    notice('实时预览已生成，确认前请检查正文首尾和完整内容');
  } catch (error) { notice(error.message, true); }
  const ruleConfirm = event.target.closest('[data-rule-confirm]'); if (ruleConfirm) try {
    const preview = state.extractionPreviews.get(ruleConfirm.dataset.ruleConfirm);
    if (!preview) throw new Error('请先生成该文章的实时预览');
    await api(`/admin/v1/feeds/${encodeURIComponent(state.extractionRule.feedId)}/extraction-rule/confirm`, {
      method: 'POST', body: JSON.stringify({ articleId: ruleConfirm.dataset.ruleConfirm, previewHash: preview.previewHash }),
    });
    await loadExtractionRule(state.extractionRule.feedId);
    notice('样本已确认');
  } catch (error) { notice(error.message, true); }
  const rulePublish = event.target.closest('[data-rule-publish]'); if (rulePublish) try {
    if (!confirm('确定发布此草稿？发布只影响后续解析，不会自动处理历史文章。')) return;
    const payload = await api(`/admin/v1/feeds/${encodeURIComponent(state.extractionRule.feedId)}/extraction-rule/publish`, { method: 'POST', body: JSON.stringify({ sampleArticleIds: Array.from(state.extractionSelected) }) });
    notice('正文规则已发布');
    const ids = payload.data?.selectedArticleIds || [];
    if (ids.length && confirm(`是否立即重新解析已选的 ${ids.length} 篇样本？正文 hash 变化后会重新分类，但不会自动重翻。`)) {
      const results = await settleInBatches(ids, 4, (id) => api(`/admin/v1/articles/${encodeURIComponent(id)}/reparse`, { method: 'POST', body: JSON.stringify({}) }));
      const failed = results.filter((result) => result.status === 'rejected').length;
      notice(failed ? `${ids.length - failed} 篇已提交，${failed} 篇失败` : `${ids.length} 篇样本已进入重解析队列`, failed > 0);
    }
    await loadExtractionRule(state.extractionRule.feedId, true);
  } catch (error) { notice(error.message, true); }
  const ruleAbandon = event.target.closest('[data-rule-abandon]'); if (ruleAbandon) try {
    if (!confirm('确定放弃当前草稿？活动规则不受影响。')) return;
    await api(`/admin/v1/feeds/${encodeURIComponent(state.extractionRule.feedId)}/extraction-rule/draft`, { method: 'DELETE' });
    await loadExtractionRule(state.extractionRule.feedId, true);
    notice('草稿已放弃');
  } catch (error) { notice(error.message, true); }
  const ruleRollback = event.target.closest('[data-rule-rollback]'); if (ruleRollback) try {
    if (!confirm('确定将此历史版本恢复为活动规则？历史文章不会自动重解析。')) return;
    await api(`/admin/v1/feeds/${encodeURIComponent(state.extractionRule.feedId)}/extraction-rule/rollback/${encodeURIComponent(ruleRollback.dataset.ruleRollback)}`, { method: 'POST', body: JSON.stringify({}) });
    await loadExtractionRule(state.extractionRule.feedId, true);
    notice('活动规则已回滚');
  } catch (error) { notice(error.message, true); }
  const feedDelete = event.target.closest('[data-feed-delete]'); if (feedDelete) {
    if (!confirm(`确定删除无人关注的订阅源“${feedDelete.dataset.feedTitle}”？文章记录会保留，但不再归属于该订阅源。`)) return;
    try {
      await api(`/admin/v1/feeds/${feedDelete.dataset.feedDelete}`, { method: 'DELETE' });
      notice('订阅源已删除');
      await loadFeeds();
    } catch (error) { notice(error.message, true); }
    return;
  }
  const feedOpen = event.target.closest('[data-feed-open]'); if (feedOpen && !event.target.closest('[data-feed-refresh],[data-feed-name-edit],[data-copy],[data-feed-delete],[data-rule-open]')) {
    const feed = state.feeds.find((item) => item.id === feedOpen.dataset.feedOpen);
    parsePagination.offset = 0;
    openDialog('#parse-dialog', () => {
      $('#parse-filter-form').elements.feedId.value = feedOpen.dataset.feedOpen;
      $('#parse-heading').textContent = `${feed?.title || '订阅源'} · 文章解析进度`;
    });
    try { await loadParseProgress(); } catch (error) { notice(error.message, true); }
  }
  const feedRefresh = event.target.closest('[data-feed-refresh]'); if (feedRefresh) try {
    await api(`/admin/v1/feeds/${feedRefresh.dataset.feedRefresh}/refresh`, { method: 'POST', body: JSON.stringify({}) });
    notice('订阅源已加入抓取队列'); await loadFeeds();
  } catch (error) { notice(error.message, true); }
  const bulkParseAction = event.target.closest('[data-bulk-parse-action]'); if (bulkParseAction) try {
    const action = bulkParseAction.dataset.bulkParseAction;
    const items = eligibleParseItems(action);
    const selectedCount = selectedParseIds.size;
    const skippedCount = selectedCount - items.length;
    const label = ({ 'parse-retry': '重试失败的正文解析', reparse: '正文解析', reclassify: 'AI 全文预处理' })[action] || '执行操作';
    if (!items.length) return notice('所选文章中没有可执行该操作的项目', true);
    if (!confirm(`确定对 ${items.length} 篇文章执行“${label}”${skippedCount ? `？另有 ${skippedCount} 篇因状态不符将跳过` : '？'}`)) return;
    const results = await settleInBatches(items, 4, (item) => api(`/admin/v1/articles/${item.id}/${action}`, { method: 'POST', body: JSON.stringify({}) }));
    const failedCount = results.filter((result) => result.status === 'rejected').length;
    notice(failedCount ? `${items.length - failedCount} 篇已提交，${failedCount} 篇失败` : `${items.length} 篇已提交${skippedCount ? `，跳过 ${skippedCount} 篇` : ''}`, failedCount > 0);
    await Promise.all([loadFeeds(), loadParseProgress()]);
  } catch (error) { notice(error.message, true); }
  const parseAction = event.target.closest('[data-parse-action]'); if (parseAction) try {
    const label = ({ 'parse-retry': '重试正文解析', reparse: '正文解析', reclassify: 'AI 全文预处理' })[parseAction.dataset.parseAction] || '执行操作';
    if (!confirm(`确定${label}这篇文章？`)) return;
    await api(`/admin/v1/articles/${parseAction.dataset.id}/${parseAction.dataset.parseAction}`, { method: 'POST', body: JSON.stringify({}) });
    notice(`${label}任务已进入队列`); await Promise.all([loadFeeds(), loadParseProgress()]);
  } catch (error) { notice(error.message, true); }
  const typeEdit = event.target.closest('[data-type-edit]'); if (typeEdit) {
    const item = state.articleTypes.find((x) => x.key === typeEdit.dataset.typeEdit);
    openDialog('#article-type-edit-dialog', () => {
      const form = $('#article-type-edit-form');
      form.dataset.key = item.key;
      form.elements.key.value = item.key;
      form.elements.description.value = item.description || '';
    });
  }
  const configEdit = event.target.closest('[data-config-edit]'); if (configEdit) {
    const item = state.configs.find((x) => x.configKey === configEdit.dataset.configEdit && x.status === 'active');
    openDialog('#config-edit-dialog', () => {
      const form = $('#config-edit-form');
      form.dataset.key = item.configKey;
      form.elements.configKey.value = item.configKey;
      form.elements.value.value = JSON.stringify(item.value, null, 2);
    });
  }
  const typeToggle = event.target.closest('[data-type-toggle]'); if (typeToggle) try {
    const enabled = typeToggle.dataset.enabled === 'true';
    if (enabled && !confirm(`确定禁用文章类型 ${typeToggle.dataset.typeToggle}？`)) return;
    await api(`/admin/v1/article-types/${typeToggle.dataset.typeToggle}`, { method: 'PATCH', body: JSON.stringify({ isEnabled: !enabled }) });
    notice(enabled ? '文章类型已禁用' : '文章类型已启用');
    await loadConfiguration();
  } catch (error) { notice(error.message, true); }
  const configDelete = event.target.closest('[data-config-delete]'); if (configDelete) try {
    if (!confirm(`确定删除系统配置 ${configDelete.dataset.configLabel}？删除活动版本时会自动启用上一版本。`)) return;
    await api(`/admin/v1/system-config-versions/${configDelete.dataset.configDelete}`, { method: 'DELETE' });
    notice('系统配置版本已删除');
    await loadConfiguration();
  } catch (error) { notice(error.message, true); }
  const prompt = event.target.closest('[data-prompt-action]');
  if (prompt) try {
    if (prompt.dataset.promptAction === 'delete') {
      if (!confirm('确定删除此提示词配置及其当前发布状态？历史版本和审计记录会保留。')) return;
      await api(`/admin/v1/prompts/${prompt.dataset.id}`, { method: 'DELETE', body: JSON.stringify({ changeNote: 'Admin Web 删除' }) });
      notice('提示词配置已删除');
      await loadPrompts();
      return;
    }
    if (prompt.dataset.promptAction === 'versions') { const data = await api(`/admin/v1/prompts/${prompt.dataset.id}/versions`); $(`#versions-${prompt.dataset.id}`).innerHTML = `<div class="row-actions">${data.items.map((v) => `<button data-publish="${v.id}" data-definition="${prompt.dataset.id}" class="ghost">v${v.version} ${escapeHtml(v.status)} · 发布</button>`).join('')}</div>`; }
    if (prompt.dataset.promptAction === 'edit') {
      const versions = await api(`/admin/v1/prompts/${prompt.dataset.id}/versions`);
      openDialog('#prompt-edit-dialog', () => {
        const form = $('#prompt-edit-form');
        form.dataset.id = prompt.dataset.id;
        form.elements.content.value = versions.items?.[0]?.content || '';
        form.elements.changeNote.value = 'Admin Web 编辑';
      });
    }
    if (prompt.dataset.promptAction === 'test') { const articleId = window.prompt('用于测试的文章 ID'); if (articleId) { await api(`/admin/v1/prompts/${prompt.dataset.id}/test`, { method: 'POST', body: JSON.stringify({ articleId }) }); notice('测试调用成功'); } }
  } catch (error) { notice(error.message, true); }
  const publish = event.target.closest('[data-publish]'); if (publish) try { await api(`/admin/v1/prompts/${publish.dataset.definition}/activate`, { method: 'POST', body: JSON.stringify({ versionId: publish.dataset.publish, changeNote: 'Admin Web 发布' }) }); notice('提示词已发布'); await loadPrompts(); } catch (error) { notice(error.message, true); }
  const profile = event.target.closest('[data-profile-action]'); if (profile) try {
    if (profile.dataset.profileAction === 'edit') {
      const item = state.profiles.find((candidate) => candidate.id === profile.dataset.id);
      if (!item) throw new Error('未找到要编辑的 AI Profile 版本');
      openDialog('#profile-dialog', () => initializeProfileForm(item));
      return;
    }
    if (profile.dataset.profileAction === 'delete') {
      if (!confirm('确定删除此 AI Profile 版本？删除活动版本时会自动启用上一归档版本。')) return;
      await api(`/admin/v1/ai-profiles/${profile.dataset.id}`, { method: 'DELETE' });
      notice('AI Profile 版本已删除');
    } else {
      await api(`/admin/v1/ai-profiles/${profile.dataset.id}/${profile.dataset.profileAction}`, { method: 'POST', body: JSON.stringify({}) });
      notice(profile.dataset.profileAction === 'publish' ? 'Profile 已发布' : '连通测试成功');
    }
    await loadProfiles();
  } catch (error) { notice(error.message, true); }
  const taskDiagnostics = event.target.closest('[data-task-diagnostics]'); if (taskDiagnostics) {
    const target = $(`#diagnostics-${CSS.escape(taskDiagnostics.dataset.taskDiagnostics)}`);
    if (target.dataset.loaded === 'true') {
      target.hidden = !target.hidden;
      return;
    }
    try {
      await Loading.query(target, async () => {
        const payload = await api(`/admin/v1/translations/${taskDiagnostics.dataset.taskDiagnostics}`);
        target.innerHTML = renderTaskDiagnostics(payload.data?.diagnostics || []);
        target.dataset.loaded = 'true';
      }, '正在读取失败响应…');
    } catch (error) { notice(error.message, true); }
    return;
  }
  const task = event.target.closest('[data-task-action]'); if (task) try { await api(`/admin/v1/translations/${task.dataset.id}/${task.dataset.taskAction}`, { method: 'POST', body: JSON.stringify({}) }); notice('任务操作已接受'); await loadTasks(); } catch (error) { notice(error.message, true); }
  const article = event.target.closest('[data-article-action]'); if (article) try { const body = article.dataset.articleAction === 'retranslate' ? { targetLocale: 'zh-CN', parentTranslationId: article.dataset.parent } : {}; await api(`/admin/v1/articles/${article.dataset.id}/${article.dataset.articleAction}`, { method: 'POST', body: JSON.stringify(body) }); notice('文章操作已接受'); await loadTasks(); } catch (error) { notice(error.message, true); }
}

const asyncActionSelector = '[data-refresh],[data-refresh-parse],[data-feed-refresh],[data-parse-action],[data-bulk-parse-action],[data-type-toggle],[data-config-delete],[data-prompt-action],[data-publish],[data-profile-action],[data-task-diagnostics],[data-task-action],[data-article-action],[data-rule-preview],[data-rule-confirm],[data-rule-publish],[data-rule-abandon],[data-rule-rollback],[data-rule-sample-reset]';
document.body.addEventListener('click', (event) => {
  const button = event.target.closest(`button:is(${asyncActionSelector})`);
  return button ? Loading.button(button, () => handleAdminClick(event)) : handleAdminClick(event);
});

$('#prompt-form').addEventListener('submit', async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); if (['classification', 'title_translation'].includes(data.task)) data.articleType = null; await Loading.button(event.submitter, async () => { try { await api('/admin/v1/prompts', { method: 'POST', body: JSON.stringify(data) }); form.closest('dialog').close(); form.reset(); notice('提示词草稿已创建'); await loadPrompts(); } catch (error) { notice(error.message, true); } }, '保存中…'); });
$('#feed-filter-form').addEventListener('submit', async (event) => { event.preventDefault(); feedPagination.offset = 0; await Loading.button(event.submitter, async () => { try { await loadFeeds(); } catch (error) { notice(error.message, true); } }, '查询中…'); });
$('#parse-filter-form').addEventListener('submit', async (event) => { event.preventDefault(); parsePagination.offset = 0; await Loading.button(event.submitter, async () => { try { await loadParseProgress(); } catch (error) { notice(error.message, true); } }, '查询中…'); });
$('#parse-select-all').addEventListener('change', (event) => {
  state.parseProgress.forEach((item) => event.currentTarget.checked ? selectedParseIds.add(item.id) : selectedParseIds.delete(item.id));
  document.querySelectorAll('[data-parse-select]').forEach((checkbox) => { checkbox.checked = event.currentTarget.checked; });
  updateParseBulkControls();
});
$('#parse-list').addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-parse-select]');
  if (!checkbox) return;
  checkbox.checked ? selectedParseIds.add(checkbox.dataset.parseSelect) : selectedParseIds.delete(checkbox.dataset.parseSelect);
  updateParseBulkControls();
});
$('#extraction-samples').addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-rule-sample-select]');
  if (!checkbox) return;
  checkbox.checked ? state.extractionSelected.add(checkbox.dataset.ruleSampleSelect) : state.extractionSelected.delete(checkbox.dataset.ruleSampleSelect);
  renderExtractionRule();
});
$('#feed-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault(); const form = event.currentTarget;
  await Loading.button(event.submitter, async () => { try { await api('/admin/v1/feeds', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.closest('dialog').close(); form.reset(); feedPagination.offset = 0; notice('订阅源已新增并进入抓取队列'); await loadFeeds(); } catch (error) { notice(error.message, true); } }, '保存中…');
});
$('#feed-name-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const form = event.currentTarget;
  await Loading.button(event.submitter, async () => {
    try {
      await api(`/admin/v1/feeds/${encodeURIComponent(form.dataset.id)}`, {
        method: 'PATCH', body: JSON.stringify({ title: form.elements.title.value.trim() }),
      });
      form.closest('dialog').close();
      notice('订阅源名称已更新');
      await loadFeeds();
    } catch (error) { notice(error.message, true); }
  }, '保存中…');
});
$('#platform-rule-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const form = event.currentTarget;
  await Loading.button(event.submitter, async () => {
    try {
      const id = form.dataset.id;
      const payload = { name: form.elements.name.value.trim(), isEnabled: form.elements.isEnabled.checked, rule: extractionRuleFromForm(form) };
      await api(id ? `/admin/v1/platform-extraction-rules/${encodeURIComponent(id)}` : '/admin/v1/platform-extraction-rules', {
        method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload),
      });
      form.closest('dialog').close();
      notice(id ? '平台正文规则已更新' : '平台正文规则已创建；不会触发文章抓取');
      await loadPlatformRules();
    } catch (error) { notice(error.message, true); }
  }, '保存中…');
});
$('#extraction-rule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  await Loading.button(event.submitter, async () => {
    try {
      const rule = extractionRuleFromForm();
      const feedId = state.extractionRule.feedId;
      await api(`/admin/v1/feeds/${encodeURIComponent(feedId)}/extraction-rule/draft`, {
        method: 'POST', body: JSON.stringify({ rule, changeNote: form.elements.changeNote.value }),
      });
      await loadExtractionRule(feedId, true);
      notice('新草稿版本已保存；可直接发布，也可先预览样本');
    } catch (error) { notice(error.message, true); }
  }, '保存草稿中…');
});
$('#extraction-sample-search').addEventListener('submit', async (event) => {
  event.preventDefault();
  await Loading.button(event.submitter, async () => {
    try {
      const query = event.currentTarget.elements.query.value.trim();
      const payload = await api(`/admin/v1/feeds/${encodeURIComponent(state.extractionRule.feedId)}/extraction-rule/samples?query=${encodeURIComponent(query)}`);
      state.extractionRule.samples = payload.items || [];
      state.extractionPreviews.clear();
      renderExtractionRule();
    } catch (error) { notice(error.message, true); }
  }, '搜索中…');
});
$('#feed-prev').addEventListener('click', async (event) => Loading.button(event.currentTarget, async () => { feedPagination.offset = Math.max(0, feedPagination.offset - feedPagination.limit); await loadFeeds(); }, '加载中…'));
$('#feed-next').addEventListener('click', async (event) => Loading.button(event.currentTarget, async () => { if (!feedPagination.hasMore) return; feedPagination.offset += feedPagination.limit; await loadFeeds(); }, '加载中…'));
$('#parse-prev').addEventListener('click', async (event) => Loading.button(event.currentTarget, async () => { parsePagination.offset = Math.max(0, parsePagination.offset - parsePagination.limit); await loadParseProgress(); }, '加载中…'));
$('#parse-next').addEventListener('click', async (event) => Loading.button(event.currentTarget, async () => { if (!parsePagination.hasMore) return; parsePagination.offset += parsePagination.limit; await loadParseProgress(); }, '加载中…'));
$('#feed-list').addEventListener('keydown', (event) => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-feed-open]')) { event.preventDefault(); event.target.click(); } });
$('#prompt-edit-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  await Loading.button(event.submitter, async () => {
    try {
      await api(`/admin/v1/prompts/${form.dataset.id}`, { method: 'PATCH', body: JSON.stringify(data) });
      form.closest('dialog').close();
      notice('提示词草稿已更新');
      await loadPrompts();
    } catch (error) { notice(error.message, true); }
  }, '保存中…');
});
$('#article-type-edit-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const form = event.currentTarget;
  await Loading.button(event.submitter, async () => {
    try {
      await api(`/admin/v1/article-types/${form.dataset.key}`, { method: 'PATCH', body: JSON.stringify({ description: form.elements.description.value }) });
      form.closest('dialog').close();
      notice('文章类型说明已更新');
      await loadConfiguration();
    } catch (error) { notice(error.message, true); }
  }, '保存中…');
});
$('#config-edit-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const form = event.currentTarget;
  await Loading.button(event.submitter, async () => {
    try {
      const value = JSON.parse(form.elements.value.value);
      await api(`/admin/v1/system-configs/${form.dataset.key}`, { method: 'POST', body: JSON.stringify({ value }) });
      form.closest('dialog').close();
      notice('系统配置新版本已发布');
      await loadConfiguration();
    } catch (error) { notice(error.message, true); }
  }, '发布中…');
});
$('#profile-form').addEventListener('submit', async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); data.profile = form.dataset.profile || data.profile; data.maxOutputTokens = data.maxOutputTokens === '' ? null : Number(data.maxOutputTokens); await Loading.button(event.submitter, async () => { try { data.parameters = JSON.parse(data.parameters || '{}'); const editing = Boolean(form.dataset.sourceId); await api(editing ? `/admin/v1/ai-profiles/${form.dataset.sourceId}` : '/admin/v1/ai-profile-versions', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(data) }); form.closest('dialog').close(); notice(editing ? 'AI Profile 已更新' : 'Profile 草稿已创建'); await loadProfiles(); } catch (error) { notice(error.message, true); } }, '保存中…'); });
$('#logout').addEventListener('click', (event) => Loading.button(event.currentTarget, async () => {
  if (window.adminAuth.hasSession()) return window.adminAuth.logout();
  try { await window.adminAuth.login(); } catch (error) { notice(error.message, true); }
}));

async function bootstrap() {
  try {
    await window.adminAuth.completeCallback();
    renderRoute();
    if (window.adminAuth.local && !window.adminAuth.hasSession()) {
      $('#logout').textContent = '登录 Admin Access';
      notice('请先登录 Admin Cloudflare Access', true);
      return;
    }
    await loadRoute();
  } catch (error) { notice(error.message, true); }
}
bootstrap();
