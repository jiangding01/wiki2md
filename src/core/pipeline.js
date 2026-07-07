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
    complexTable: 'auto',
    highlightAnchors: true,
    keepHistory: true,
    customRules: [],
  };

  /**
   * 设置合并：默认值 ← 存储 ← 本次消息覆盖。
   * 存储策略「本地为主、同步尽力」：storage.sync 单项仅 8KB，自定义规则多了会超限，
   * 所以写入方总是写 local（必成）并尽力写 sync（跨设备）；读取时 local 优先，
   * local 为空（如新设备刚同步过来）再读 sync。
   */
  async function loadSettings(overrides) {
    let stored = {};
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        stored = (await chrome.storage.local.get('inkmarkSettings')).inkmarkSettings;
        if (!stored) {
          stored = (await chrome.storage.sync.get('inkmarkSettings')).inkmarkSettings || {};
        }
      }
    } catch (e) { /* 测试环境无 chrome */ }
    return Object.assign({}, DEFAULTS, stored || {}, overrides || {});
  }

  function progress(text) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ type: 'INK_PROGRESS', text }).catch(() => {});
      }
    } catch (e) { /* popup 已关闭等情况，忽略 */ }
  }
  window.__inkProgress = progress; // 供适配器上报（如飞书滚动采集）

  /**
   * 导出忙态的真实来源在页面侧（popup 关闭重开后其内存互斥态会丢失，
   * 而导出仍在页面里继续跑）。计数 + 广播，popup 据此恢复禁用状态。
   */
  let activeExports = 0;
  function broadcastBusy() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ type: 'INK_BUSY', busy: activeExports > 0 }).catch(() => {});
      }
    } catch (e) { /* popup 未开启等情况 */ }
  }
  async function withExportBusy(fn) {
    activeExports += 1;
    broadcastBusy();
    try {
      return await fn();
    } finally {
      activeExports -= 1;
      broadcastBusy();
    }
  }
  window.__inkmarkExporting = () => activeExports > 0;

  /** 提取结果缓存：analyze 和 export 之间不重复跑适配器（飞书滚动采集很贵）。
   *  key 必须包含 URL——SPA 站点（知乎切换回答、飞书切换文档）不刷新页面，
   *  内容脚本常驻，否则第二篇文章会命中第一篇的缓存（脏读）。 */
  let cache = { ir: null, key: null };
  let inflight = { key: null, promise: null };

  async function getIR(settings) {
    // key 保留 hash：hash 路由的 SPA（docsify 等 domain/#/page 形态）切文章时只有
    // hash 变化，剥掉会脏读旧缓存；代价是点击页内锚点后首次导出会重新提取（可接受）
    const key = JSON.stringify({
      u: location.href,
      c: settings.includeComments,
      r: settings.customRules,
    });
    if (cache.ir && cache.key === key) return cache.ir;
    // 并发去重：popup 分析与快捷键导出同时触发时只跑一次提取
    // （飞书滚动采集若并发执行会互相打架）
    if (inflight.promise && inflight.key === key) return inflight.promise;

    inflight = {
      key,
      promise: (async () => {
        // 页面还在加载时提取会拿到半页内容：等 DOM 就绪（5s 兜底超时）
        if (document.readyState === 'loading') {
          progress('等待页面加载…');
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 5000);
            document.addEventListener('DOMContentLoaded', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        }
        window.__inkCustomRules = settings.customRules || [];
        const adapter = InkAdapters.resolve();
        progress(`正在提取（${adapter.name}）…`);
        const ir = await adapter.extract(settings);
        ir._adapter = {
          id: adapter.id, name: adapter.name, badge: adapter.badge,
          authImages: !!adapter.authImages,
        };
        InkIR.restoreMath(ir.contentEl || document.createElement('div'));
        cache = { ir, key };
        return ir;
      })(),
    };
    const mine = inflight;
    try {
      return await inflight.promise;
    } finally {
      // 只清理自己的记录：SPA 切换后旧请求先完成时，不能抹掉新 key 的 in-flight 记录
      if (inflight === mine) inflight = { key: null, promise: null };
    }
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
      exporting: activeExports > 0, // popup 重开时据此恢复互斥忙态
    };
  }

  async function handleExport(action, options) {
    const settings = await loadSettings(options);
    let ir = await getIR(settings);
    if (settings.title && settings.title.trim()) {
      // popup 里用户可改标题——用浅拷贝覆盖，绝不改写共享缓存里的 IR
      // （直接改会污染后续所有 analyze/export，直到页面刷新）
      ir = Object.assign({}, ir, { title: settings.title.trim() });
    }
    const markdown = InkMarkdown.render(ir, settings);
    const filename = InkExporter.buildFilename(settings.filenameTemplate, ir, 'md');

    if (action === 'markdown') {
      if (settings.keepHistory && (settings.intent === 'copy' || settings.intent === 'batch')) {
        await InkExporter.recordHistory(ir, markdown, filename, settings.intent);
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

  /**
   * Confluence 页面树批量导出：当前页 + 全部子孙页面 → 一个 ZIP（目录镜像层级）。
   * 全程走同源 REST API，不打开任何标签页。评论不随树导出（每页多一次 API，
   * 大空间下太慢）；失败页面写入 ZIP 内的「导出报告.md」，绝不静默丢失。
   */
  const TREE_MAX_PAGES = 300;

  async function handleExportTree(options) {
    const settings = await loadSettings(options);
    window.__inkCustomRules = settings.customRules || [];
    const adapter = InkAdapters.resolve();
    if (adapter.id !== 'confluence') {
      return { ok: false, error: '页面树导出目前仅支持 Confluence 页面' };
    }
    const rootId = adapter._pageId();
    if (!rootId) return { ok: false, error: '未能识别当前页面的 pageId' };

    const base = adapter._baseUrl();
    let rootIR = await getIR(settings);
    if (settings.title && settings.title.trim()) {
      // 与单页导出行为一致：popup 里改过的标题作用于根页与 ZIP 文件名（浅拷贝，不污染缓存）
      rootIR = Object.assign({}, rootIR, { title: settings.title.trim() });
    }
    // 文件/目录名净化统一走 InkExporter.sanitizeName（单一实现，规则不漂移）
    const safe = (s) => InkExporter.sanitizeName(s, 80);

    const nodes = [{ ir: rootIR, path: [] , title: rootIR.title }];
    const queue = [{ id: rootId, path: [rootIR.title] }];
    const failures = [];
    let fetched = 1;

    while (queue.length) {
      const cur = queue.shift();
      let children = [];
      try {
        children = await adapter.fetchChildren(cur.id);
      } catch (e) {
        failures.push(`页面 ${cur.id} 的子页面列表拉取失败：${e.message}`);
        continue;
      }
      for (const child of children) {
        if (fetched >= TREE_MAX_PAGES) {
          failures.push(`超出 ${TREE_MAX_PAGES} 页安全上限，「${child.title}」及之后的页面未导出`);
          queue.length = 0;
          break;
        }
        fetched += 1;
        progress(`抓取第 ${fetched} 页：${child.title}`);
        try {
          const meta = await adapter.fetchPageHtml(child.id);
          const url = `${base}/pages/viewpage.action?pageId=${child.id}`;
          nodes.push({ ir: adapter.htmlToIR(meta, url), path: cur.path, title: meta.title });
          queue.push({ id: child.id, path: cur.path.concat(meta.title) });
        } catch (e) {
          failures.push(`「${child.title || child.id}」抓取失败：${e.message}`);
        }
      }
    }

    progress('正在转换并打包…');
    const zip = new JSZip();
    const renderOpts = Object.assign({}, settings, { includeComments: false });
    const used = new Set();
    let imageCount = 0;
    let imageFailed = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const dir = n.path.map(safe).join('/');
      let name = safe(n.title);
      let full = (dir ? dir + '/' : '') + name + '.md';
      for (let k = 2; used.has(full); k++) full = (dir ? dir + '/' : '') + `${name}-${k}.md`;
      used.add(full);

      let md = InkMarkdown.render(n.ir, renderOpts);
      // 页面树的使用场景就是 Confluence——图片全部需要登录态，
      // 远程链接在本地必然裂图，所以每一页都做图片本地化。
      // 目录结构：每层目录只有一个 assets/，内部按页面名分子目录——
      // 目录列表不被「每篇 md 一个长名文件夹」翻倍，配对关系仍一眼可见，
      // 单独移动某篇 md 时带走 assets/<同名>/ 即可。
      const fileBase = full.slice(full.lastIndexOf('/') + 1, -3);
      progress(`图片本地化 ${i + 1}/${nodes.length}：${n.title}`);
      const localized = await InkExporter.localizeImages(md, null, `assets/${fileBase}`);
      md = localized.markdown;
      imageCount += localized.files.size;
      imageFailed += localized.failed.length;
      for (const [assetPath, blob] of localized.files) {
        zip.file((dir ? dir + '/' : '') + assetPath, blob);
      }
      if (localized.failed.length) {
        failures.push(`「${n.title}」有 ${localized.failed.length} 张图片抓取失败，已保留远程链接`);
      }
      zip.file(full, md);
    }
    if (failures.length) {
      zip.file('导出报告.md',
        `# 页面树导出报告\n\n成功导出 ${nodes.length} 页。以下 ${failures.length} 项失败：\n\n` +
        failures.map(f => `- ${f}`).join('\n') + '\n');
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    InkExporter.downloadBlob(blob, InkExporter.buildFilename('{title}-页面树', rootIR, 'zip'));
    return { ok: true, pages: nodes.length, failed: failures.length, images: imageCount, imageFailed };
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
  window.__inkmark = { getIR, handleAnalyze, handleExport, handleExportSelection, handleExportTree, loadSettings };

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const run = async () => {
      try {
        if (msg.type === 'INK_ANALYZE') return await handleAnalyze(msg.options);
        if (msg.type === 'INK_EXPORT') return await withExportBusy(() => handleExport(msg.action, msg.options));
        if (msg.type === 'INK_EXPORT_SELECTION') return await withExportBusy(() => handleExportSelection(msg.options));
        if (msg.type === 'INK_EXPORT_TREE') return await withExportBusy(() => handleExportTree(msg.options));
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
