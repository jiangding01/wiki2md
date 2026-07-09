/**
 * 摘墨 · Confluence 适配器（精配）
 *
 * - 正文：#main-content / .wiki-content，规范化代码宏与信息面板
 * - 评论：REST API（同源请求自动携带登录态）
 *   · 页面评论：/rest/api/content/{id}/child/comment?expand=body.view,history
 *   · 划线评论：extensions.inlineProperties.originalSelection 提供锚点原文
 * - 兼容 Server/DC 与 Cloud 两种部署形态
 */

// 幂等声明：重复注入时复用首次实例（const 重声明会抛错；裸 var 重建会清空注册表等内部状态）
var ConfluenceAdapter = window.ConfluenceAdapter || {
  id: 'confluence',
  name: 'Confluence',
  badge: 'precise',
  authImages: true, // 图片需登录态，远程链接在本地 md 里打不开

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
    try {
      return await this._fetchCommentsDeep(pageId);
    } catch (e) {
      // descendant 端点异常（老版本实例等）：回退 child 通道（仅一层回复）
      return this._fetchCommentsShallow(pageId);
    }
  },

  /**
   * descendant/comment 一次拿全所有层级的评论——child/comment + expand 只能
   * 展开一层回复，Server/DC 上更深的回复会被静默丢掉。回复不论嵌套多深都
   * 收进顶层评论的 replies（导出呈现本就只有一层缩进），顺序保持接口返回序。
   */
  async _fetchCommentsDeep(pageId) {
    const base = this._baseUrl();
    let url = `${base}/rest/api/content/${pageId}/descendant/comment` +
      `?expand=body.view,history,extensions.inlineProperties,ancestors&limit=50`;
    const results = [];
    for (let page = 0; url && page < 20; page++) {
      const data = await this._apiGet(url);
      results.push(...(data.results || []));
      url = (data._links && data._links.next)
        ? ((data._links.base || base) + data._links.next)
        : null;
    }
    const isComment = (a) => a && a.type === 'comment';
    const topById = new Map();
    const out = [];
    for (const c of results) {
      if ((c.ancestors || []).some(isComment)) continue; // 回复稍后归组
      const ann = this._toAnnotation(c);
      topById.set(c.id, ann);
      out.push(ann);
    }
    for (const c of results) {
      const ancs = (c.ancestors || []).filter(isComment);
      if (!ancs.length) continue;
      const ann = this._toAnnotation(c);
      // 祖先链里找到属于本页顶层的那条（不假设 ancestors 的排列方向）
      const top = ancs.map(a => topById.get(a.id)).find(Boolean);
      if (top) top.replies.push(ann);
      else out.push(ann); // 祖先缺失的孤儿评论：顶层兜底，绝不静默丢弃
    }
    return out;
  },

  /** 回退通道：child/comment + 一层 expand（descendant 不可用时的旧行为） */
  async _fetchCommentsShallow(pageId) {
    const base = this._baseUrl();
    let url = `${base}/rest/api/content/${pageId}/child/comment` +
      `?expand=body.view,history,extensions.inlineProperties,children.comment.body.view,children.comment.history&limit=50`;
    const out = [];
    // 分页拉全：大文档的评论可能远超一页
    for (let page = 0; url && page < 10; page++) {
      const data = await this._apiGet(url);
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
    const res = await InkExporter.fetchJsonWithTimeout(url,
      { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json;
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
