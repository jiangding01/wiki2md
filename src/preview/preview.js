/**
 * 摘墨 · 预览页控制器
 * 从 chrome.storage.local 读取 popup 暂存的 markdown，分屏展示。
 */

const IS_EXTENSION = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.runtime && chrome.runtime.id);

let current = { markdown: '', title: '预览', filename: 'untitled.md' };

document.addEventListener('DOMContentLoaded', async () => {
  document.body.dataset.view = 'split';

  if (IS_EXTENSION) {
    const { inkmarkPreview } = await chrome.storage.local.get('inkmarkPreview');
    if (inkmarkPreview && inkmarkPreview.markdown) current = inkmarkPreview;
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

  document.getElementById('btn-download').addEventListener('click', () => {
    const blob = new Blob([current.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = current.filename || 'untitled.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
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
  if (frontMatter) {
    const meta = document.createElement('div');
    meta.className = 'meta-strip';
    frontMatter.split('\n').forEach((line) => {
      const m = line.match(/^([\w-]+):\s*"?(.*?)"?$/);
      if (!m || m[1] === 'tags') return;
      const chip = document.createElement('span');
      chip.className = 'meta-chip';
      chip.innerHTML = `<b>${m[1]}</b>${escapeHtml(m[2])}`;
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

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
