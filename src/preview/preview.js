/**
 * 摘墨 · 预览页控制器
 * 从 chrome.storage.local 读取 popup 暂存的 markdown，分屏展示。
 */

const IS_EXTENSION = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.runtime && chrome.runtime.id);

let current = { markdown: '', title: '预览', filename: 'untitled.md' };

// 双栏同步滚动的「源码行号 ↔ 渲染块」映射状态，renderMarkdown() 每次重渲染后重建。
// valid=false 时（映射算法判定不可信）scrollLock 逻辑会整体回退到比例同步。
let syncState = { blocks: null, elements: [], valid: false };

document.addEventListener('DOMContentLoaded', async () => {
  document.body.dataset.view = 'split';

  if (IS_EXTENSION) {
    // storage.local 只是 popup → 预览页的交接通道：读到后立刻从 local 删除
    // （隐私：全文与图片数据不长驻本机，PRIVACY.md 口径）——删除动作绝不
    // 受后面转存成败牵连。轻量部分（markdown/标题等）转存 sessionStorage
    // 供刷新恢复；base64 图片可达几十 MB，sessionStorage 5MB 配额放不下、
    // 序列化本身也贵——只存内存，刷新后不保留（renderMarkdown 会给出提示）。
    const { inkmarkPreview } = await chrome.storage.local.get('inkmarkPreview');
    if (inkmarkPreview && inkmarkPreview.markdown) {
      current = inkmarkPreview;
      chrome.storage.local.remove('inkmarkPreview');
      try {
        const light = Object.assign({}, inkmarkPreview);
        delete light.images;
        sessionStorage.setItem('inkmarkPreview', JSON.stringify(light));
      } catch (e) { /* 超配额等：放弃转存，刷新后回到空态 */ }
    } else {
      try {
        const stash = sessionStorage.getItem('inkmarkPreview');
        if (stash) current = JSON.parse(stash);
      } catch (e) { /* 解析失败按无内容处理 */ }
    }
  } else {
    current = demoData(); // 独立打开时的设计稿数据
  }

  document.getElementById('doc-title').textContent = current.title || '预览';
  document.getElementById('doc-filename').textContent = current.filename || '';
  document.title = `摘墨 · ${current.title || '预览'}`;

  const source = document.getElementById('source');
  source.value = current.markdown;
  renderMarkdown();

  // 源码可编辑：改动实时重渲染（250ms 防抖），下载/复制用的都是编辑后的内容
  let renderTimer = null;
  source.addEventListener('input', () => {
    current.markdown = source.value;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderMarkdown, 250);
  });

  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.body.dataset.view = btn.dataset.view;
    });
  });

  document.getElementById('btn-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(current.markdown);
    const btn = document.getElementById('btn-copy');
    btn.textContent = '已复制 ✓';
    setTimeout(() => { btn.textContent = '复制 Markdown'; }, 1500);
  });

  // 对照视图双栏同步滚动：优先用 InkPreviewSync 建立的「源码行号 ↔ 渲染块」映射
  // 做锚点级对齐（对齐块顶部，块内按比例线性插值避免跳变）；映射不可用时（空
  // 文档、顶层块数与实际 DOM 节点数对不上等，见 renderMarkdown 里的判定）整体
  // 回退到旧版按滚动条高度比例双向换算。scrollLock + rAF 防止两侧 scroll
  // 事件互相触发形成回环抖动。
  const paneRendered = document.querySelector('.pane-rendered');
  const sourcePane = source; // textarea 自身滚动
  let scrollLock = false;

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  const ratioSync = (from, to) => {
    const fromMax = Math.max(1, from.scrollHeight - from.clientHeight);
    const toMax = Math.max(0, to.scrollHeight - to.clientHeight);
    to.scrollTop = (from.scrollTop / fromMax) * toMax;
  };

  // textarea 是 white-space: pre-wrap，超长行会自动折成多个视觉行，
  // 「scrollTop / 行高」算出来的是「视觉行号」的近似值而非严格的逻辑行号——
  // 正常文档（短行居多）里两者基本重合；单个超长段落内部可能有局部漂移，
  // 但块边界一到、下一次滚动事件就会用新的 offsetTop 重新对齐，不会累积。
  const sourceLineHeight = () => {
    const lh = parseFloat(getComputedStyle(sourcePane).lineHeight);
    return Number.isFinite(lh) && lh > 0 ? lh : 18;
  };

  const syncFromSource = () => {
    if (!syncState.valid) { ratioSync(sourcePane, paneRendered); return; }
    const line = 1 + sourcePane.scrollTop / sourceLineHeight();
    const loc = InkPreviewSync.locate(syncState.blocks, line);
    const el = loc && syncState.elements[loc.blockIndex];
    if (!el) { ratioSync(sourcePane, paneRendered); return; }
    const target = el.offsetTop + loc.fraction * el.offsetHeight;
    paneRendered.scrollTop = clamp(target, 0, Math.max(0, paneRendered.scrollHeight - paneRendered.clientHeight));
  };

  const syncFromRendered = () => {
    if (!syncState.valid) { ratioSync(paneRendered, sourcePane); return; }
    const top = paneRendered.scrollTop;
    const elements = syncState.elements;
    let idx = 0;
    for (let i = 0; i < elements.length; i++) {
      if (elements[i].offsetTop <= top + 1) idx = i; else break;
    }
    const el = elements[idx];
    const fraction = el.offsetHeight > 0 ? clamp((top - el.offsetTop) / el.offsetHeight, 0, 1) : 0;
    const line = InkPreviewSync.unlocate(syncState.blocks, idx, fraction);
    const target = (line - 1) * sourceLineHeight();
    sourcePane.scrollTop = clamp(target, 0, Math.max(0, sourcePane.scrollHeight - sourcePane.clientHeight));
  };

  paneRendered.addEventListener('scroll', () => {
    if (scrollLock) return;
    scrollLock = true;
    syncFromRendered();
    requestAnimationFrame(() => { scrollLock = false; });
  }, { passive: true });
  sourcePane.addEventListener('scroll', () => {
    if (scrollLock) return;
    scrollLock = true;
    syncFromSource();
    requestAnimationFrame(() => { scrollLock = false; });
  }, { passive: true });

  // 「本地打包」预览携带图片数据：下载按钮产出与主面板一致的 ZIP
  //（md + assets/），否则拿到的 md 里全是 assets/ 死引用
  const hasImages = !!(current.images && current.images.length);
  const btnDownload = document.getElementById('btn-download');
  if (hasImages) btnDownload.textContent = '下载 .zip';
  btnDownload.addEventListener('click', async () => {
    if (!hasImages) {
      InkUI.downloadBlob(
        new Blob([current.markdown], { type: 'text/markdown;charset=utf-8' }),
        current.filename || 'untitled.md');
      return;
    }
    // ZIP 生成是异步重活：忙态防连点，否则两次点击并发解码出双份 ZIP
    if (btnDownload.disabled) return;
    btnDownload.disabled = true;
    const label = btnDownload.textContent;
    btnDownload.textContent = '打包中…';
    try {
      // 目录布局须与 InkExporter.downloadZip 保持一致（<base>/index.md +
      // <base>/assets/…）——两处运行环境隔离无法共用实现，改结构要同步改
      const base = (current.filename || 'untitled.md').replace(/\.md$/, '');
      const zip = new JSZip();
      zip.file(`${base}/index.md`, current.markdown);
      for (const img of current.images) {
        try {
          zip.file(`${base}/${img.path}`, InkUI.base64ToBlob(img.base64));
        } catch (e) { /* 单图数据损坏：跳过，不拖垮整包 */ }
      }
      InkUI.downloadBlob(await zip.generateAsync({ type: 'blob' }), `${base}.zip`);
    } finally {
      btnDownload.disabled = false;
      btnDownload.textContent = label;
    }
  });

  renderNotice();
});

/** 预览质量提示：图片超预算降级 / 部分抓取失败 / 刷新后内嵌图释放 */
function renderNotice() {
  const el = document.getElementById('preview-notice');
  if (!el) return;
  const notes = [];
  if (current.oversize) {
    notes.push('图片总量超出单次传输预算，本次预览为远程链接版（下载为 .md）；如需带图产物请在面板用「下载 ZIP」。');
  } else if (current.imageFailed > 0) {
    notes.push(`${current.imageFailed} 张图片抓取失败，已保留远程链接。`);
  }
  if (!current.oversize && !(current.images && current.images.length) &&
      current.markdown && current.markdown.includes('](assets/')) {
    notes.push('内嵌图片数据不随页面刷新保留，如需查看请从面板重新打开预览。');
  }
  el.textContent = notes.join(' ');
  el.classList.toggle('hidden', notes.length === 0);
}

/**
 * DOM 级消毒：markdown 来自任意网页，可能携带原始 HTML（复杂表格直通等）。
 * 移除脚本类元素、on* 事件属性与危险协议 URL——即便 MV3 扩展页 CSP
 * 已拦截内联脚本，这里仍做纵深防御。
 */
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, link, meta, form, base').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    Array.from(el.attributes).forEach((attr) => {
      if (/^on/i.test(attr.name)) {
        el.removeAttribute(attr.name);
      } else if ((attr.name === 'href' || attr.name === 'src') &&
                 /^\s*(javascript|vbscript|data\s*:\s*text)/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.innerHTML;
}

/** 渲染视图：front matter 不作为正文渲染，转为元数据 chip 条 */
const inlineImageUrls = new Map(); // assets 路径 → blob URL，跨重渲染复用

function renderMarkdown() {
  const { frontMatter, body } = splitFrontMatter(current.markdown);
  const rendered = document.getElementById('rendered');
  rendered.innerHTML = sanitizeHtml(marked.parse(body, { breaks: false, gfm: true }));
  // 「本地打包」预览：assets/ 相对引用换成内存图（扩展页无源站登录态，远程链接必裂）
  InkUI.applyInlineImages(rendered, current.images, inlineImageUrls);

  // 重建同步滚动映射：只有当 marked token 数与本次实际渲染出的顶层 DOM 节点数
  // 严格一一对应时才可信（原始 HTML 块可能被 sanitizeHtml 整体删掉，或注释类
  // 节点压根不产出 Element，都会导致数量对不上）——对不上就整体判定不可用，
  // 交给 syncFromSource/syncFromRendered 回退比例同步，不做半吊子对齐。
  const blockEls = Array.from(rendered.children);
  const map = InkPreviewSync.buildBlockMap(current.markdown, marked.lexer);
  syncState = (map && map.blocks.length === blockEls.length)
    ? { blocks: map.blocks, elements: blockEls, valid: true }
    : { blocks: null, elements: [], valid: false };

  if (frontMatter) {
    const meta = document.createElement('div');
    meta.className = 'meta-strip';
    frontMatter.split('\n').forEach((line) => {
      const m = line.match(/^([\w-]+):\s*"?(.*?)"?$/);
      if (!m || m[1] === 'tags') return;
      const chip = document.createElement('span');
      chip.className = 'meta-chip';
      chip.innerHTML = `<b>${m[1]}</b>${InkUI.escapeHtml(m[2])}`;
      meta.appendChild(chip);
    });
    rendered.prepend(meta);
  }
}

function splitFrontMatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { frontMatter: null, body: md };
  return { frontMatter: m[1], body: md.slice(m[0].length) };
}

function demoData() {
  return {
    title: '支付网关重构 · 技术方案评审',
    filename: '支付网关重构 · 技术方案评审.md',
    markdown: [
      '---',
      'title: "支付网关重构 · 技术方案评审"',
      'source: "https://wiki.example.com/pages/128450"',
      'author: "林晚秋"',
      'site: "Confluence"',
      'clipped: "2026-07-07T09:30:00.000Z"',
      'tags: [clippings]',
      '---',
      '',
      '# 支付网关重构 · 技术方案评审',
      '',
      '## 背景',
      '',
      '当前支付网关承载了 **12 条业务线** 的交易流量，日均调用 2.3 亿次[^1]。旧架构在大促期间多次出现熔断误判，评审目标是确定新一代网关的技术选型。',
      '',
      '> ⚠️ **注意**',
      '>',
      '> 本方案涉及资金链路，任何改动需通过双人评审 + 灰度发布。',
      '',
      '## 技术选型对比',
      '',
      '| 方案 | 吞吐 (QPS) | 延迟 P99 | 迁移成本 |',
      '| --- | --- | --- | --- |',
      '| 自研 Netty 网关 | 85,000 | 12ms | 高 |',
      '| Envoy + Wasm 插件 | 72,000 | 18ms | 中 |',
      '| Spring Cloud Gateway | 31,000 | 45ms | 低 |',
      '',
      '核心路由逻辑示意：',
      '',
      '```java',
      'public Route resolve(PaymentRequest req) {',
      '    return routeTable.match(req.getBizLine(), req.getChannel())',
      '                     .orElseThrow(RouteMissException::new);',
      '}',
      '```',
      '',
      '[^1]: **陈默 · 2026-07-05 14:22**：这个数字是 6 月大盘，含重试流量，去重后约 1.9 亿。',
      '',
      '---',
      '',
      '## 💬 评论',
      '',
      '> **赵砚 · 2026-07-06 10:05**',
      '> Envoy 方案的 Wasm 插件生态去年成熟了很多，建议把它列为首选。',
      '>',
      '> > **林晚秋 · 2026-07-06 10:40**',
      '> > 同意，下周我补一个 Envoy 的压测报告。',
      '',
    ].join('\n'),
  };
}
