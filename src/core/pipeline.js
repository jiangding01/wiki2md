/**
 * 摘墨 · 内容脚本编排器
 *
 * 完整流水线：resolve 适配器 → extract 出 IR → render 成 Markdown → 输出。
 * popup / background / batch 页通过消息驱动，本文件是页面侧唯一入口。
 *
 * 消息协议（chrome.runtime message）：
 *   { type: 'INK_ANALYZE', options }         → { ok, adapter, title, stats, warnings }
 *   { type: 'INK_EXPORT', action, options }  → action: 'markdown' | 'download' | 'zip'
 *   { type: 'INK_EXPORT_SELECTION' }         → 右键菜单：仅导出选中内容
 * 反向进度：content → { type: 'INK_PROGRESS', text }（popup 实时展示）
 */

(function () {
  if (window.__INKMARK_LOADED__) return; // 防重复注入
  window.__INKMARK_LOADED__ = true;

  const DEFAULTS = {
    frontMatter: true,
    includeTitle: true,
    includeComments: true,
    commentStyle: 'both',
    imageStrategy: 'remote',
    filenameTemplate: '{title}',
    frontMatterTags: 'clippings',
    mdBullet: '-',
    mdEmphasis: '*',
    mdFence: '```',
    mdLinkStyle: 'inlined',
    complexTable: 'html',
    keepHistory: true,
    customRules: [],
  };

  /** 设置合并：默认值 ← storage.sync ← 本次消息覆盖 */
  async function loadSettings(overrides) {
    let stored = {};
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        stored = (await chrome.storage.sync.get('inkmarkSettings')).inkmarkSettings || {};
      }
    } catch (e) { /* 测试环境无 chrome */ }
    return Object.assign({}, DEFAULTS, stored, overrides || {});
  }

  function progress(text) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ type: 'INK_PROGRESS', text }).catch(() => {});
      }
    } catch (e) { /* popup 已关闭等情况，忽略 */ }
  }
  window.__inkProgress = progress; // 供适配器上报（如飞书滚动采集）

  /** 提取结果缓存：analyze 和 export 之间不重复跑适配器（飞书滚动采集很贵） */
  let cache = { ir: null, key: null };

  async function getIR(settings) {
    const key = JSON.stringify({ c: settings.includeComments, r: settings.customRules });
    if (cache.ir && cache.key === key) return cache.ir;

    window.__inkCustomRules = settings.customRules || [];
    const adapter = InkAdapters.resolve();
    progress(`正在提取（${adapter.name}）…`);
    const ir = await adapter.extract(settings);
    ir._adapter = { id: adapter.id, name: adapter.name, badge: adapter.badge };
    InkIR.restoreMath(ir.contentEl || document.createElement('div'));
    cache = { ir, key };
    return ir;
  }

  async function handleAnalyze(options) {
    const settings = await loadSettings(options);
    const ir = await getIR(settings);
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
    const settings = await loadSettings(options);
    const ir = await getIR(settings);
    if (settings.title && settings.title.trim()) ir.title = settings.title.trim(); // popup 里用户可改标题
    const markdown = InkMarkdown.render(ir, settings);
    const filename = InkExporter.buildFilename(settings.filenameTemplate, ir, 'md');

    if (action === 'markdown') {
      if (settings.keepHistory && settings.intent === 'copy') {
        await InkExporter.recordHistory(ir, markdown, filename, 'copy');
      }
      return { ok: true, markdown, filename, title: ir.title };
    }
    if (action === 'download') {
      InkExporter.downloadMarkdown(markdown, filename);
      if (settings.keepHistory) await InkExporter.recordHistory(ir, markdown, filename, 'download');
      return { ok: true, filename };
    }
    if (action === 'zip') {
      const result = await InkExporter.downloadZip(
        markdown, ir, settings.filenameTemplate,
        (done, total) => progress(`抓取图片 ${done}/${total}…`)
      );
      if (settings.keepHistory) await InkExporter.recordHistory(ir, markdown, filename, 'zip');
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
    InkIR.restoreMath(container);

    const ir = InkIR.create({
      title: (document.title || '选中内容') + ' - 节选',
      contentEl: container,
    });
    const settings = await loadSettings(options);
    const opts = Object.assign({}, settings, { frontMatter: false, includeTitle: false, includeComments: false });
    const markdown = InkMarkdown.render(ir, opts);
    InkExporter.downloadMarkdown(markdown, InkExporter.buildFilename('{title}', ir, 'md'));
    if (settings.keepHistory) {
      await InkExporter.recordHistory(ir, markdown, InkExporter.buildFilename('{title}', ir, 'md'), 'selection');
    }
    return { ok: true };
  }

  // 供测试环境直接调用（fixture 页面里没有 chrome.runtime）
  window.__inkmark = { getIR, handleAnalyze, handleExport, handleExportSelection, loadSettings };

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

  /* 适配器注册：顺序即优先级——用户自定义规则最优先，Generic 永远最后 */
  InkAdapters.register(CustomRuleAdapter);
  InkAdapters.register(ConfluenceAdapter);
  InkAdapters.register(FeishuAdapter);
  InkAdapters.register(WechatAdapter);
  InkAdapters.register(ZhihuAdapter);
  InkAdapters.register(JuejinAdapter);
  InkAdapters.register(CsdnAdapter);
  InkAdapters.register(YuqueAdapter);
  InkAdapters.register(StackOverflowAdapter);
  InkAdapters.register(GenericAdapter);
})();
