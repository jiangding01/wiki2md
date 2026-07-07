/**
 * 摘墨 · 内容脚本编排器
 *
 * 完整流水线：resolve 适配器 → extract 出 IR → render 成 Markdown → 输出。
 * popup / background 通过消息驱动，本文件是页面侧唯一入口。
 *
 * 消息协议（chrome.runtime message）：
 *   { type: 'INK_ANALYZE', options }             → { ok, adapter, title, stats, warnings }
 *   { type: 'INK_EXPORT', action, options }      → action: 'markdown' | 'download' | 'zip'
 *   { type: 'INK_EXPORT_SELECTION' }             → 右键菜单：仅导出选中内容
 */

(function () {
  if (window.__INKMARK_LOADED__) return; // 防重复注入
  window.__INKMARK_LOADED__ = true;

  /** 提取结果缓存：analyze 和 export 之间不重复跑适配器（飞书滚动采集很贵） */
  let cache = { ir: null, optionsKey: null };

  async function getIR(options) {
    const key = JSON.stringify({ c: options.includeComments });
    if (cache.ir && cache.optionsKey === key) return cache.ir;
    const adapter = InkAdapters.resolve();
    const ir = await adapter.extract(options);
    ir._adapter = { id: adapter.id, name: adapter.name, badge: adapter.badge };
    cache = { ir, optionsKey: key };
    return ir;
  }

  async function handleAnalyze(options) {
    const ir = await getIR(options || {});
    return {
      ok: true,
      adapter: ir._adapter,
      title: ir.title,
      byline: ir.byline,
      siteName: ir.siteName,
      stats: InkIR.stats(ir),
      warnings: ir.warnings,
    };
  }

  async function handleExport(action, options) {
    const opts = options || {};
    const ir = await getIR(opts);
    if (opts.title && opts.title.trim()) ir.title = opts.title.trim(); // popup 里用户可改标题
    const markdown = InkMarkdown.render(ir, opts);
    const filename = InkExporter.buildFilename(opts.filenameTemplate, ir, 'md');

    if (action === 'markdown') {
      return { ok: true, markdown, filename, title: ir.title };
    }
    if (action === 'download') {
      InkExporter.downloadMarkdown(markdown, filename);
      return { ok: true, filename };
    }
    if (action === 'zip') {
      const result = await InkExporter.downloadZip(markdown, ir, opts.filenameTemplate);
      return { ok: true, filename: filename.replace(/\.md$/, '.zip'), ...result };
    }
    throw new Error('未知导出动作: ' + action);
  }

  async function handleExportSelection(options) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      return { ok: false, error: '当前没有选中任何内容' };
    }
    const container = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) {
      container.appendChild(sel.getRangeAt(i).cloneContents());
    }
    InkIR.removeNoise(container);
    InkIR.fixLazyImages(container);
    InkIR.absolutizeUrls(container);

    const ir = InkIR.create({
      title: (document.title || '选中内容') + ' - 节选',
      contentEl: container,
    });
    const opts = Object.assign({}, options, { frontMatter: false, includeTitle: false, includeComments: false });
    const markdown = InkMarkdown.render(ir, opts);
    InkExporter.downloadMarkdown(markdown, InkExporter.buildFilename('{title}', ir, 'md'));
    return { ok: true };
  }

  // 供测试环境直接调用（fixture 页面里没有 chrome.runtime）
  window.__inkmark = { getIR, handleAnalyze, handleExport, handleExportSelection };

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const run = async () => {
      try {
        if (msg.type === 'INK_ANALYZE') return await handleAnalyze(msg.options);
        if (msg.type === 'INK_EXPORT') return await handleExport(msg.action, msg.options);
        if (msg.type === 'INK_EXPORT_SELECTION') return await handleExportSelection(msg.options);
        return { ok: false, error: '未知消息类型' };
      } catch (e) {
        console.error('[inkmark]', e);
        return { ok: false, error: e.message || String(e) };
      }
    };
    run().then(sendResponse);
    return true; // 异步响应
  });
  }

  /* 适配器注册：顺序即优先级，Generic 永远最后 */
  InkAdapters.register(ConfluenceAdapter);
  InkAdapters.register(FeishuAdapter);
  InkAdapters.register(WechatAdapter);
  InkAdapters.register(ZhihuAdapter);
  InkAdapters.register(JuejinAdapter);
  InkAdapters.register(GenericAdapter);
})();
