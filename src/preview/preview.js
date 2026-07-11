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
    // storage.local 只是 popup → 预览页的交接通道：读到后立刻转存本标签页的
    // sessionStorage（刷新页面内容不丢）并从 local 删除——否则上次预览的
    // 全文会一直躺在本机存储里（隐私考量，也符合 PRIVACY.md 的口径）
    const { inkmarkPreview } = await chrome.storage.local.get('inkmarkPreview');
    if (inkmarkPreview && inkmarkPreview.markdown) {
      current = inkmarkPreview;
      try {
        sessionStorage.setItem('inkmarkPreview', JSON.stringify(inkmarkPreview));
        chrome.storage.local.remove('inkmarkPreview');
      } catch (e) { /* 超大文档超出 sessionStorage 配额：保留 local 以免刷新丢内容 */ }
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

  document.getElementById('btn-download').addEventListener('click', () => {
    InkUI.downloadBlob(
      new Blob([current.markdown], { type: 'text/markdown;charset=utf-8' }),
      current.filename || 'untitled.md');
  });
});

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
function renderMarkdown() {
  const { frontMatter, body } = splitFrontMatter(current.markdown);
  const rendered = document.getElementById('rendered');
  rendered.innerHTML = sanitizeHtml(marked.parse(body, { breaks: false, gfm: true }));

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
