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

  /** 设置合并：默认值 ← 存储 ← 本次消息覆盖（实现见 core/settings.js，全插件唯一） */
  async function loadSettings(overrides) {
    return InkSettings.merged(overrides);
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

  async function getIR(settings, force) {
    // key 保留 hash：hash 路由的 SPA（docsify 等 domain/#/page 形态）切文章时只有
    // hash 变化，剥掉会脏读旧缓存；代价是点击页内锚点后首次导出会重新提取（可接受）
    const key = JSON.stringify({
      u: location.href,
      c: settings.includeComments,
      r: settings.customRules,
    });
    // force（「重新分析」按钮）绕过缓存与在途去重：页面内容变了而 URL 没变时，
    // 这是用户拿到新结果的唯一通道
    if (!force) {
      if (cache.ir && cache.key === key) return cache.ir;
      // 并发去重：popup 分析与快捷键导出同时触发时只跑一次提取
      // （飞书滚动采集若并发执行会互相打架）
      if (inflight.promise && inflight.key === key) return inflight.promise;
    }

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
          id: adapter.id, name: adapter.name,
          // 适配器可按本次提取实际走的路径覆盖徽章（飞书：接口成功=precise，回退滚动=experimental）
          badge: ir.badge || adapter.badge,
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
    const ir = await getIR(settings, !!(options && options.forceRefresh));
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
    if (action === 'localized') {
      // 批量导出用：图片抓取必须发生在本页上下文（登录态只在页面里），
      // 抓好的图以 base64 随消息带回，由批量页统一写 ZIP。
      const localized = await InkExporter.localizeImages(
        markdown,
        (done, total) => progress(`抓取图片 ${done}/${total}…`),
        settings.assetDir || 'assets'
      );
      if (settings.keepHistory) {
        // 历史记录存未本地化的 markdown——脱离 ZIP 的 assets 相对路径没有意义
        await InkExporter.recordHistory(ir, markdown, filename, 'batch');
      }
      let totalBytes = 0;
      for (const blob of localized.files.values()) totalBytes += blob.size;
      if (totalBytes > MESSAGE_IMAGE_BUDGET) {
        // 超预算的页面整页降级为远程链接，绝不让一页撑爆整批消息通道
        return { ok: true, markdown, filename, title: ir.title, images: [], imageFailed: 0, oversize: true };
      }
      // base64 转码是纯本地异步操作，并行把 N 张图压成近似单张耗时
      const images = await Promise.all(Array.from(localized.files, async ([path, blob]) =>
        ({ path, base64: await InkExporter.blobToBase64(blob) })));
      return {
        ok: true,
        markdown: localized.markdown,
        filename, title: ir.title, images,
        imageFailed: localized.failed.length,
        oversize: false,
      };
    }
    throw new Error('未知导出动作: ' + action);
  }

  /**
   * Confluence 页面树批量导出：当前页 + 全部子孙页面 → 一个 ZIP（目录镜像层级）。
   * 全程走同源 REST API，不打开任何标签页。评论跟随「导出评论」开关
   * （每页多一次 API，关掉开关即可换速度）；失败页面写入 ZIP 内的
   * 「导出报告.md」，绝不静默丢失。
   */
  const TREE_MAX_PAGES = 300;

  /** 批量导出单页图片总量预算（原始字节）。chrome 扩展消息上限 64MB，
   *  base64 膨胀 4/3：32MB 原始 ≈ 43MB 编码后，给 markdown 与序列化留足余量。 */
  const MESSAGE_IMAGE_BUDGET = 32 * 1024 * 1024;

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
    let capped = false;

    while (queue.length) {
      const cur = queue.shift();
      let children = [];
      try {
        children = await adapter.fetchChildren(cur.id);
      } catch (e) {
        failures.push(`页面 ${cur.id} 的子页面列表拉取失败：${e.message}`);
        continue;
      }
      const capacity = TREE_MAX_PAGES - fetched;
      if (children.length > capacity) {
        failures.push(`超出 ${TREE_MAX_PAGES} 页安全上限，「${children[capacity] ? children[capacity].title : ''}」及之后的页面未导出`);
        children = children.slice(0, capacity);
        // 硬停：清空待爬队列，且本批页面只导出、不再入队下钻——
        // 否则队列会被下面的 queue.push 重新填满，触顶后继续打 REST 并重复报「超限」
        capped = true;
        queue.length = 0;
      }
      fetched += children.length;
      // 同层子页面 3 路并发抓取（串行时大空间导出被 RTT 主导），结果保持原顺序
      const results = await InkExporter.mapPool(children, 3, async (child) => {
        progress(`抓取页面：${child.title}`);
        try {
          // 评论跟随「导出评论」开关（每页 +1 次 API）；与正文并行拉取——
          // 二者互不依赖，串行会让大空间的抓取墙钟接近翻倍。
          // 3 路池 × 每页 2 请求 = 6 在途，贴着浏览器同主机连接上限，不超。
          // 评论失败只降级告警，绝不影响该页正文导出。
          let commentError = null;
          const commentState = {};
          const commentsP = settings.includeComments !== false
            ? adapter.fetchCommentsFor(child.id, commentState)
                .catch((e) => { commentError = e; return []; })
            : Promise.resolve([]);
          const [meta, annotations] = await Promise.all([
            adapter.fetchPageHtml(child.id), commentsP,
          ]);
          return { child, meta, annotations, commentError, commentState };
        } catch (e) {
          return { child, error: e };
        }
      });
      for (const r of results) {
        if (r.error) {
          failures.push(`「${r.child.title || r.child.id}」抓取失败：${r.error.message}`);
          continue;
        }
        const url = `${base}/pages/viewpage.action?pageId=${r.child.id}`;
        const ir = adapter.htmlToIR(r.meta, url);
        ir.annotations = r.annotations;
        if (r.commentError) {
          failures.push(`「${r.meta.title}」评论拉取失败（${r.commentError.message}），仅导出正文`);
        } else if (r.commentState.truncated) {
          failures.push(`「${r.meta.title}」评论超出拉取上限，已截断`);
        }
        nodes.push({ ir, path: cur.path, title: r.meta.title });
        if (!capped) queue.push({ id: r.child.id, path: cur.path.concat(r.meta.title) });
      }
    }

    progress('正在转换并打包…');
    const zip = new JSZip();
    const renderOpts = Object.assign({}, settings); // 评论呈现方式与单页导出一致

    // 第一步（顺序）：分配文件名——去重必须有序，才能保证 zip 目录确定性。
    // 目录结构：每层目录只有一个 assets/，内部按页面名分子目录——
    // 目录列表不被「每篇 md 一个长名文件夹」翻倍，配对关系仍一眼可见，
    // 单独移动某篇 md 时带走 assets/<同名>/ 即可。
    const used = new Set();
    const entries = nodes.map((n) => {
      const dir = n.path.map(safe).join('/');
      const name = safe(n.title);
      let full = (dir ? dir + '/' : '') + name + '.md';
      for (let k = 2; used.has(full); k++) full = (dir ? dir + '/' : '') + `${name}-${k}.md`;
      used.add(full);
      const fileBase = full.slice(full.lastIndexOf('/') + 1, -3);
      return { n, dir, full, fileBase };
    });

    // 第二步（3 路并发）：md 渲染 + 逐页图片本地化。页面树的使用场景就是
    // Confluence——图片全部需要登录态，远程链接在本地必然裂图。
    // 渲染放进池里与图片下载重叠，第一张图不用等全部页面渲染完。
    // 页面级 3 路 × 页内抓图 2 路 = 总并发 6，贴着浏览器同主机连接上限，
    // 不再触发企业站点的服务端限流（12 路并发时能成功的图会批量 429）。
    // 单页失败降级为「该页保留远程链接」，绝不让一页异常拖垮整个导出。
    let localizedDone = 0;
    let imageCount = 0;
    let imageFailed = 0;
    const localizedList = await InkExporter.mapPool(entries, 3, async (entry) => {
      let localized;
      try {
        const md = InkMarkdown.render(entry.n.ir, renderOpts);
        localized = await InkExporter.localizeImages(md, null, `assets/${entry.fileBase}`, 2);
      } catch (e) {
        localized = { markdown: `> ⚠️ 本页转换失败：${e.message}\n`, files: new Map(), failed: [], error: e };
      }
      localizedDone += 1;
      progress(`图片本地化 ${localizedDone}/${entries.length}：${entry.n.title}`);
      return localized;
    });

    // 第三步（顺序）：写入 zip 与失败账目
    entries.forEach((entry, i) => {
      const localized = localizedList[i];
      imageCount += localized.files.size;
      imageFailed += localized.failed.length;
      for (const [assetPath, blob] of localized.files) {
        zip.file((entry.dir ? entry.dir + '/' : '') + assetPath, blob);
      }
      if (localized.error) {
        failures.push(`「${entry.n.title}」转换失败：${localized.error.message}`);
      } else if (localized.failed.length) {
        failures.push(`「${entry.n.title}」有 ${localized.failed.length} 张图片抓取失败，已保留远程链接`);
      }
      zip.file(entry.full, localized.markdown);
    });
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
    InkIR.normalizeContainer(container);
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
