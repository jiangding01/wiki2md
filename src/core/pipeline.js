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
   * Confluence 页面树批量导出：当前页 + 全部子孙页面 → ZIP（目录镜像层级）。
   * 全程走同源 REST API，不打开任何标签页。评论跟随「导出评论」开关
   * （每页多一次 API，关掉开关即可换速度）；失败页面写入 ZIP 内的
   * 「导出报告.md」，绝不静默丢失。
   *
   * 分卷：一卷填满即打包为独立 ZIP 立刻下载、释放内存后继续遍历，突破
   * 单 ZIP 的内存/体积上限（整库导出前置）。assets 归属随卷、卷内自洽。
   * 单卷以内的小树与旧行为完全一致（文件名不带卷号、报告仅在有失败时生成）。
   *
   * 断点续传：每卷完成时把「根 id / BFS 队列游标 / 各卷清单 / 失败清单」等
   * 轻量数据持久化到 chrome.storage.local（IR 含游离 DOM 不可序列化，故只存
   * id/标题/路径）。中断后可从上次的卷边界继续，跳过已下载的卷、重拉未完成页面。
   */

  /** 分卷与总量上限（常量化并暴露给测试覆写，见 window.__inkmark.__treeConfig）。
   *  volumePages=300：与旧单包上限一致——单卷内产物和旧行为逐字节一致，无回归；
   *    超过一卷即分卷，突破单 ZIP 的内存/体积限制。
   *  maxPages=3000：整库导出的安全阀——防止误触极大空间时无限遍历、
   *    以及续传清单撑爆 chrome.storage 预算（3000 页清单约 0.2MB，远低于配额）。 */
  const treeConfig = { volumePages: 300, maxPages: 3000 };

  /** 断点续传状态的存储 key（独立于 inkmarkSettings / inkmarkHistory） */
  const TREE_RESUME_KEY = 'inkmarkTreeResume';

  /** 批量导出单页图片总量预算（原始字节）。chrome 扩展消息上限 64MB，
   *  base64 膨胀 4/3：32MB 原始 ≈ 43MB 编码后，给 markdown 与序列化留足余量。 */
  const MESSAGE_IMAGE_BUDGET = 32 * 1024 * 1024;

  async function loadTreeResume() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
    try {
      const got = await chrome.storage.local.get(TREE_RESUME_KEY);
      return got[TREE_RESUME_KEY] || null;
    } catch (e) { return null; }
  }
  async function saveTreeResume(state) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    try {
      await chrome.storage.local.set({ [TREE_RESUME_KEY]: state });
    } catch (e) { console.warn('[inkmark] tree resume save failed:', e); } // 续传失败绝不阻塞导出
  }
  async function clearTreeResume() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    try { await chrome.storage.local.remove(TREE_RESUME_KEY); } catch (e) { /* 忽略 */ }
  }

  /** popup 侧「继续/重来」询问用的状态探测：当前页 rootId 是否有可续传的未完成导出 */
  async function handleTreeStatus() {
    const adapter = InkAdapters.resolve();
    if (adapter.id !== 'confluence' || !adapter._pageId) return { ok: true, resumable: false };
    const rootId = adapter._pageId();
    const st = await loadTreeResume();
    const resumable = !!(st && rootId && String(st.rootId) === String(rootId));
    return {
      ok: true,
      resumable,
      volumesDownloaded: resumable ? (st.volumesDownloaded || 0) : 0,
      pagesDone: resumable ? (st.pagesDone || 0) : 0,
      rootTitle: resumable ? st.rootTitle : null,
    };
  }

  /** 页面树导出报告（仅最后一卷附带）：各卷清单 + 失败项 */
  function buildTreeReport(ctx, single) {
    const totalVolumes = ctx.volumeManifest.length;
    const out = [`# 页面树导出报告`, '',
      `成功导出 ${ctx.pagesDone} 页${single ? '' : `，共 ${totalVolumes} 卷`}。`, ''];
    if (!single) {
      out.push('## 各卷清单', '');
      for (const v of ctx.volumeManifest) {
        out.push(`### 卷 ${v.volume}（${v.files.length} 页）`, '');
        out.push(v.files.map(f => `- ${f}`).join('\n'), '');
      }
    }
    if (ctx.failures.length) {
      out.push(`## 失败项（${ctx.failures.length}）`, '');
      out.push(ctx.failures.map(f => `- ${f}`).join('\n'), '');
    }
    return out.join('\n');
  }

  /**
   * 打包并下载一卷。final=true 为最后一卷（附导出报告、清除续传状态、文件名不带卷号当且仅当全程只有一卷）。
   * 文件名分配（去重）按卷内自洽——卷边界确定性由遍历顺序保证，故各卷两次导出内容一致。
   * 每层目录只有一个 assets/，内部按页面名分子目录（配对关系一眼可见，单独移动 md 时带走同名 assets 即可）。
   */
  async function packTreeVolume(volumeNodes, ctx, final) {
    if (!volumeNodes.length) return; // 空卷不打包（收尾的空缓冲由 handleExportTree 单独补发报告）
    const volumeNumber = ctx.volumesDownloaded + 1;
    const single = final && ctx.volumesDownloaded === 0; // 全程只有这一卷 → 文件名不带卷号
    const safe = (s) => InkExporter.sanitizeName(s, 80);
    progress(single ? '正在转换并打包…' : `正在打包第 ${volumeNumber} 卷…`);

    const zip = new JSZip();
    const renderOpts = Object.assign({}, ctx.settings); // 评论呈现方式与单页导出一致

    // 第一步（顺序）：卷内分配文件名——去重必须有序，才能保证 zip 目录确定性
    const used = new Set();
    const entries = volumeNodes.map((n) => {
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
    // 页面级 3 路 × 页内抓图 2 路 = 总并发 6，贴着浏览器同主机连接上限，
    // 不再触发企业站点的服务端限流。单页失败降级为「保留远程链接」，绝不拖垮整卷。
    let localizedDone = 0;
    const localizedList = await InkExporter.mapPool(entries, 3, async (entry) => {
      let localized;
      try {
        const md = InkMarkdown.render(entry.n.ir, renderOpts);
        localized = await InkExporter.localizeImages(md, null, `assets/${entry.fileBase}`, 2);
      } catch (e) {
        localized = { markdown: `> ⚠️ 本页转换失败：${e.message}\n`, files: new Map(), failed: [], error: e };
      }
      localizedDone += 1;
      progress(`${single ? '' : `卷 ${volumeNumber} · `}图片本地化 ${localizedDone}/${entries.length}：${entry.n.title}`);
      return localized;
    });

    // 第三步（顺序）：写入 zip 与失败账目
    entries.forEach((entry, i) => {
      const localized = localizedList[i];
      ctx.imageCount += localized.files.size;
      ctx.imageFailed += localized.failed.length;
      for (const [assetPath, blob] of localized.files) {
        zip.file((entry.dir ? entry.dir + '/' : '') + assetPath, blob);
      }
      if (localized.error) {
        ctx.failures.push(`「${entry.n.title}」转换失败：${localized.error.message}`);
      } else if (localized.failed.length) {
        ctx.failures.push(`「${entry.n.title}」有 ${localized.failed.length} 张图片抓取失败，已保留远程链接`);
      }
      zip.file(entry.full, localized.markdown);
    });

    // 卷清单登记（供最后一卷的导出报告汇总；轻量——仅 md 相对路径）
    ctx.volumeManifest.push({ volume: volumeNumber, files: entries.map(e => e.full) });

    // 最后一卷附导出报告：多卷必附（含各卷清单），单卷沿用旧行为——仅有失败时才附
    if (final && (!single || ctx.failures.length)) {
      zip.file('导出报告.md', buildTreeReport(ctx, single));
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const tpl = single ? '{title}-页面树' : `{title}-页面树-卷${volumeNumber}`;
    InkExporter.downloadBlob(blob, InkExporter.buildFilename(tpl, ctx.rootRef, 'zip'));
    ctx.volumesDownloaded = volumeNumber;
  }

  async function handleExportTree(options) {
    const opts = options || {};
    const settings = await loadSettings(opts);
    window.__inkCustomRules = settings.customRules || [];
    const adapter = InkAdapters.resolve();
    if (adapter.id !== 'confluence') {
      return { ok: false, error: '页面树导出目前仅支持 Confluence 页面' };
    }
    const rootId = adapter._pageId();
    if (!rootId) return { ok: false, error: '未能识别当前页面的 pageId' };
    const base = adapter._baseUrl();

    // 续传探测：仅当用户在 popup 明确选择「继续」且状态确属同一根页面时才续传
    const saved = await loadTreeResume();
    const resuming = !!(opts.resume && saved && String(saved.rootId) === String(rootId));

    // 遍历上下文：ctx 里的字段既驱动打包、也是续传持久化的轻量快照来源
    const ctx = {
      rootId,
      settings,
      failures: resuming ? (saved.failures || []) : [],
      volumeManifest: resuming ? (saved.volumeManifest || []) : [],
      volumesDownloaded: resuming ? (saved.volumesDownloaded || 0) : 0,
      pagesDone: resuming ? (saved.pagesDone || 0) : 0,
      imageCount: 0,
      imageFailed: 0,
    };

    let queue;
    let volumeBuffer;
    let fetched;
    let capped;

    if (resuming) {
      // 已下载的卷不再重复打包；只恢复队列游标，从卷边界继续（当前卷缓冲从空开始）
      ctx.rootTitle = saved.rootTitle;
      ctx.rootUrl = saved.rootUrl;
      ctx.rootRef = { title: saved.rootTitle, url: saved.rootUrl };
      queue = saved.queue || [];
      volumeBuffer = [];
      fetched = saved.fetched || ctx.pagesDone;
      capped = !!saved.capped;
    } else {
      await clearTreeResume(); // 换了根页面或用户选「重新开始」：清掉旧状态
      let rootIR = await getIR(settings);
      if (settings.title && settings.title.trim()) {
        // 与单页导出行为一致：popup 里改过的标题作用于根页与 ZIP 文件名（浅拷贝，不污染缓存）
        rootIR = Object.assign({}, rootIR, { title: settings.title.trim() });
      }
      ctx.rootTitle = rootIR.title;
      ctx.rootUrl = rootIR.url;
      ctx.rootRef = rootIR;
      volumeBuffer = [{ ir: rootIR, path: [], title: rootIR.title }];
      queue = [{ id: rootId, path: [rootIR.title] }];
      ctx.pagesDone = 1; // 根页计入
      fetched = 1;
      capped = false;
    }

    while (queue.length) {
      // 满卷即打包下载并持久化续传状态——只在卷边界持久化：此刻缓冲已清空、
      // 队列完整反映全部待办，中断后从此处恢复不会重复或漏页
      if (volumeBuffer.length >= treeConfig.volumePages) {
        await packTreeVolume(volumeBuffer, ctx, false);
        volumeBuffer = [];
        await saveTreeResume({
          version: 1, rootId: ctx.rootId, rootTitle: ctx.rootTitle, rootUrl: ctx.rootUrl,
          queue, volumeManifest: ctx.volumeManifest, failures: ctx.failures,
          volumesDownloaded: ctx.volumesDownloaded, pagesDone: ctx.pagesDone,
          fetched, capped, updatedAt: Date.now(),
        });
      }

      const cur = queue.shift();
      let children = [];
      try {
        children = await adapter.fetchChildren(cur.id);
      } catch (e) {
        ctx.failures.push(`页面 ${cur.id} 的子页面列表拉取失败：${e.message}`);
        continue;
      }
      const capacity = treeConfig.maxPages - fetched;
      if (children.length > capacity) {
        ctx.failures.push(`超出 ${treeConfig.maxPages} 页安全上限，「${children[capacity] ? children[capacity].title : ''}」及之后的页面未导出`);
        children = children.slice(0, Math.max(0, capacity));
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
          ctx.failures.push(`「${r.child.title || r.child.id}」抓取失败：${r.error.message}`);
          continue;
        }
        const url = `${base}/pages/viewpage.action?pageId=${r.child.id}`;
        const ir = adapter.htmlToIR(r.meta, url);
        ir.annotations = r.annotations;
        if (r.commentError) {
          ctx.failures.push(`「${r.meta.title}」评论拉取失败（${r.commentError.message}），仅导出正文`);
        } else if (r.commentState.truncated) {
          ctx.failures.push(`「${r.meta.title}」评论超出拉取上限，已截断`);
        }
        volumeBuffer.push({ ir, path: cur.path, title: r.meta.title });
        ctx.pagesDone += 1;
        if (!capped) queue.push({ id: r.child.id, path: cur.path.concat(r.meta.title) });
      }
    }

    // 收尾：最后一卷（可能不满）打包，附导出报告
    if (volumeBuffer.length) {
      await packTreeVolume(volumeBuffer, ctx, true);
    } else if (ctx.volumesDownloaded > 0) {
      // 极端边界：内容恰好在卷边界用尽（末尾全是叶子页），单独补发一卷汇总报告，
      // 不制造带页面的空卷。多卷必附各卷清单，单卷路径不会走到这里。
      const zip = new JSZip();
      zip.file('导出报告.md', buildTreeReport(ctx, false));
      const blob = await zip.generateAsync({ type: 'blob' });
      InkExporter.downloadBlob(blob, InkExporter.buildFilename('{title}-页面树-导出报告', ctx.rootRef, 'zip'));
    }
    await clearTreeResume(); // 正常完成：清除续传状态
    return {
      ok: true,
      pages: ctx.pagesDone,
      volumes: ctx.volumesDownloaded,
      failed: ctx.failures.length,
      images: ctx.imageCount,
      imageFailed: ctx.imageFailed,
      resumed: resuming,
    };
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
  // __treeConfig 暴露分卷/总量上限，测试可临时改小以覆盖分卷与硬停路径
  window.__inkmark = {
    getIR, handleAnalyze, handleExport, handleExportSelection,
    handleExportTree, handleTreeStatus, loadSettings, __treeConfig: treeConfig,
    shouldHandleMessage,
  };

  /**
   * 广播守卫（纯函数，供测试）：不带 frameId 的 tabs.sendMessage 会同时
   * 投递到所有 frame，allFrames 注入后每个 frame 都有监听器——若子 frame
   * 也执行导出，一次点击产生多份下载（真实 bug：飞书页面双 ZIP）。
   * 规则：子 frame 只处理显式定向给自己的消息（options.frameTargeted，
   * 由 popup 选优等合法路径携带）；顶层不受限。被忽略的消息不回包，
   * 把响应让给顶层 frame。
   */
  function shouldHandleMessage(msg, isTopFrame) {
    if (isTopFrame) return true;
    return !!(msg && msg.options && msg.options.frameTargeted);
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!shouldHandleMessage(msg, window === window.top)) return;
    const run = async () => {
      try {
        if (msg.type === 'INK_ANALYZE') return await handleAnalyze(msg.options);
        if (msg.type === 'INK_EXPORT') return await withExportBusy(() => handleExport(msg.action, msg.options));
        if (msg.type === 'INK_EXPORT_SELECTION') return await withExportBusy(() => handleExportSelection(msg.options));
        if (msg.type === 'INK_EXPORT_TREE') return await withExportBusy(() => handleExportTree(msg.options));
        if (msg.type === 'INK_TREE_STATUS') return await handleTreeStatus();
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
