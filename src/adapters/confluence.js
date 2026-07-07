/**
 * 摘墨 · Confluence 适配器（精配）
 *
 * - 正文：#main-content / .wiki-content，规范化代码宏与信息面板
 * - 评论：REST API（同源请求自动携带登录态）
 *   · 页面评论：/rest/api/content/{id}/child/comment?expand=body.view,history
 *   · 划线评论：extensions.inlineProperties.originalSelection 提供锚点原文
 * - 兼容 Server/DC 与 Cloud 两种部署形态
 */

const ConfluenceAdapter = {
  id: 'confluence',
  name: 'Confluence',
  badge: 'precise',

  match(loc, doc) {
    // ?pageId= 识别来自用户 v1 插件的实战经验（Server/DC 常见的 viewpage.action?pageId=xxx 形态）
    let hasPageIdParam = false;
    try { hasPageIdParam = !!new URL(loc.href).searchParams.get('pageId'); } catch (e) { /* 忽略 */ }
    return !!(
      doc.querySelector('meta[name="ajs-page-id"]') ||
      doc.querySelector('meta[name="confluence-request-time"]') ||
      doc.body.id === 'com-atlassian-confluence' ||
      (hasPageIdParam && doc.querySelector('#main-content, #main')) ||
      (loc.pathname.includes('/wiki/') && doc.querySelector('#main-content'))
    );
  },

  async extract(options) {
    const opts = options || {};
    const sourceEl =
      document.querySelector('#main-content') ||
      document.querySelector('.wiki-content') ||
      document.querySelector('[data-testid="page-content"]') ||
      document.querySelector('#main') ||
      document.body;

    const container = document.createElement('div');
    container.appendChild(InkIR.detach(sourceEl));

    InkIR.removeNoise(container, [
      '.conf-macro.output-inline[data-macro-name="toc"]', // 目录宏（md 里冗余）
      '.page-metadata', '.pageSection.group',              // 页脚元数据/附件区
      '.expand-control',                                   // 折叠面板控件
      '.confluence-information-macro-icon',
      '.aui-icon', '.icon',
      // ↓ 用户 v1 插件在真实 Server/DC 实例上验证过的噪音清单
      'thead.tableFloatingHeader',                         // 表格浮动表头（滚动跟随的复制品）
      '.ia-fixed-sidebar', '.ia-splitter-left', '#sidebar',
      '#header', '.aui-header', '#footer', '.footer-body',
      '#comments-section',                                 // 评论区 DOM（评论走 REST API 结构化导出）
      '#likes-section', '.page-metadata-end',
      '.plugin-tabmeta-details', '.page-blog-calendar',
      '.aui-nav-actions-list', '.hidden', 'input[type="hidden"]',
    ]);

    this._normalizeCodeMacros(container);
    this._normalizePanels(container);
    this._normalizeImages(container);
    InkIR.fixLazyImages(container);
    InkIR.absolutizeUrls(container);

    const ir = InkIR.create({
      title: this._title(),
      byline: this._meta('ajs-page-version-comment-author') || this._byline(),
      siteName: 'Confluence',
      contentEl: container,
    });

    if (opts.includeComments !== false) {
      try {
        ir.annotations = await this._fetchComments();
      } catch (e) {
        ir.warnings.push('评论拉取失败（' + (e.message || e) + '），仅导出正文。');
      }
    }
    return ir;
  },

  /* ---------- 正文规范化 ---------- */

  _normalizeCodeMacros(root) {
    // Server/DC: <div class="code panel"><div class="codeContent"><pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: java; ...">
    root.querySelectorAll('div.code.panel, div.preformatted.panel').forEach((panel) => {
      const pre = panel.querySelector('pre');
      if (!pre) return;
      let lang = '';
      const params = pre.getAttribute('data-syntaxhighlighter-params') || '';
      const m = params.match(/brush:\s*([a-z0-9#+]+)/i);
      if (m) lang = m[1];
      const clean = document.createElement('pre');
      InkIR.markCodeBlock(clean, lang);
      const code = document.createElement('code');
      code.textContent = pre.textContent;
      clean.appendChild(code);
      panel.replaceWith(clean);
    });
    // Cloud: <pre data-language="java"> 或 CodeBlock 组件
    root.querySelectorAll('pre[data-language]').forEach((pre) => {
      InkIR.markCodeBlock(pre, pre.getAttribute('data-language'));
    });
  },

  _normalizePanels(root) {
    const TYPE_MAP = {
      'confluence-information-macro-information': 'info',
      'confluence-information-macro-note': 'warning',
      'confluence-information-macro-warning': 'error',
      'confluence-information-macro-tip': 'tip',
    };
    root.querySelectorAll('.confluence-information-macro').forEach((panel) => {
      let type = 'info';
      for (const cls of Object.keys(TYPE_MAP)) {
        if (panel.classList.contains(cls)) { type = TYPE_MAP[cls]; break; }
      }
      const titleEl = panel.querySelector('.title');
      InkIR.markCallout(panel, type, titleEl ? titleEl.textContent.trim() : '');
      if (titleEl) titleEl.remove();
    });
    // Cloud 新版 panel
    root.querySelectorAll('div[data-panel-type]').forEach((panel) => {
      const t = panel.getAttribute('data-panel-type');
      const map = { info: 'info', note: 'note', warning: 'warning', error: 'error', success: 'success' };
      InkIR.markCallout(panel, map[t] || 'info', '');
    });
  },

  _normalizeImages(root) {
    // Confluence 缩略图 → 原图
    root.querySelectorAll('img.confluence-embedded-image').forEach((img) => {
      const src = img.getAttribute('src') || '';
      img.setAttribute('src', src.replace('/thumbnails/', '/attachments/'));
      // 去掉尺寸限制参数，保留原图
      img.removeAttribute('width');
      img.removeAttribute('height');
    });
  },

  /* ---------- 评论拉取 ---------- */

  _pageId() {
    const m = document.querySelector('meta[name="ajs-page-id"]');
    if (m) return m.getAttribute('content');
    const u = location.pathname.match(/\/pages\/(\d+)/);
    return u ? u[1] : null;
  },

  _baseUrl() {
    const m = document.querySelector('meta[name="ajs-base-url"]');
    if (m) return m.getAttribute('content');
    // Cloud: https://xxx.atlassian.net/wiki
    const i = location.pathname.indexOf('/wiki/');
    return i >= 0 ? location.origin + '/wiki' : location.origin;
  },

  async _fetchComments() {
    const pageId = this._pageId();
    if (!pageId) return [];
    const base = this._baseUrl();
    let url = `${base}/rest/api/content/${pageId}/child/comment` +
      `?expand=body.view,history,extensions.inlineProperties,children.comment.body.view,children.comment.history&limit=50`;
    const out = [];
    // 分页拉全：大文档的评论可能远超一页
    for (let page = 0; url && page < 10; page++) {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      out.push(...(data.results || []).map(c => this._toAnnotation(c)));
      url = (data._links && data._links.next)
        ? ((data._links.base || base) + data._links.next)
        : null;
    }
    return out;
  },

  _toAnnotation(c) {
    const inlineProps = c.extensions && c.extensions.inlineProperties;
    const html = (c.body && c.body.view && c.body.view.value) || '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const ann = InkIR.annotation({
      kind: inlineProps ? 'inline' : 'page',
      anchorText: inlineProps ? (inlineProps.originalSelection || null) : null,
      author: c.history && c.history.createdBy && c.history.createdBy.displayName,
      time: c.history && c.history.createdDate
        ? new Date(c.history.createdDate).toLocaleString() : null,
      content: tmp.textContent.trim(),
    });
    const kids = c.children && c.children.comment && c.children.comment.results;
    if (kids) ann.replies = kids.map(k => this._toAnnotation(k));
    return ann;
  },

  /* ---------- 页面树批量导出（REST API，同源自动携带登录态） ---------- */

  async _apiGet(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** 某页面的直接子页面（分页拉全） */
  async fetchChildren(pageId) {
    const base = this._baseUrl();
    let url = `${base}/rest/api/content/${pageId}/child/page?limit=50`;
    const out = [];
    for (let i = 0; url && i < 10; i++) {
      const data = await this._apiGet(url);
      out.push(...(data.results || []).map(p => ({ id: p.id, title: p.title })));
      url = (data._links && data._links.next)
        ? ((data._links.base || base) + data._links.next)
        : null;
    }
    return out;
  },

  /** 拉取页面渲染后的 HTML（export_view 与页面渲染同构，可复用清洗逻辑） */
  async fetchPageHtml(pageId) {
    const base = this._baseUrl();
    const data = await this._apiGet(
      `${base}/rest/api/content/${pageId}?expand=body.export_view,history`);
    return {
      title: data.title || String(pageId),
      html: (data.body && data.body.export_view && data.body.export_view.value) || '',
      author: data.history && data.history.createdBy && data.history.createdBy.displayName,
    };
  },

  /** API 返回的 HTML → IR，与单页提取共享全部规范化逻辑 */
  htmlToIR(pageMeta, pageUrl) {
    const container = document.createElement('div');
    container.innerHTML = pageMeta.html;
    InkIR.removeNoise(container, ['.conf-macro.output-inline[data-macro-name="toc"]', '.expand-control']);
    this._normalizeCodeMacros(container);
    this._normalizePanels(container);
    this._normalizeImages(container);
    InkIR.fixLazyImages(container);
    InkIR.absolutizeUrls(container, pageUrl);
    return InkIR.create({
      title: pageMeta.title,
      byline: pageMeta.author || null,
      siteName: 'Confluence',
      url: pageUrl,
      contentEl: container,
    });
  },

  _title() {
    const t = document.querySelector('#title-text');
    if (t) return t.textContent.trim();
    return document.title.replace(/\s*[-–]\s*[^-–]*(Confluence|Wiki).*$/i, '').trim();
  },

  _byline() {
    const a = document.querySelector('.page-metadata .author, [data-testid="page-byline"] a');
    return a ? a.textContent.trim() : null;
  },

  _meta(name) {
    const m = document.querySelector(`meta[name="${name}"]`);
    return m ? m.getAttribute('content') : null;
  },
};

window.ConfluenceAdapter = ConfluenceAdapter;
