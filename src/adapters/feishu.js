/**
 * 摘墨 · 飞书文档适配器（实验性）
 *
 * 飞书 docx 使用虚拟滚动：长文档只有视口附近的 block 在 DOM 中。
 * 策略：自动滚动整篇文档，按 data-block-id 去重收集所有 block 的快照，
 * 最后按首次出现顺序拼装。滚动期间页面会自动翻页，属预期行为。
 *
 * 已知限制（badge = experimental，UI 上明确告知用户）：
 * - 表格类 block（sheet 嵌入）是 canvas 渲染，导出为占位提示
 * - 飞书前端类名随版本变化，选择器可能需要跟进
 */

const FeishuAdapter = {
  id: 'feishu',
  name: '飞书文档',
  badge: 'experimental',

  match(loc) {
    return /(\.|^)(feishu\.cn|larksuite\.com)$/.test(loc.hostname) &&
      /\/(docx|docs|wiki)\//.test(loc.pathname);
  },

  async extract() {
    const scrollHost = this._findScrollHost();
    const blocks = new Map(); // block-id → outerHTML（首次出现顺序即文档顺序）
    const warnings = [];

    const harvest = () => {
      document.querySelectorAll('[data-block-id]').forEach((el) => {
        const id = el.getAttribute('data-block-id');
        // 只收集叶层 block（不含嵌套 data-block-id 的），避免父容器重复包含子块
        if (!id || blocks.has(id)) return;
        if (el.querySelector('[data-block-id]')) return;
        blocks.set(id, el.outerHTML);
      });
    };

    if (scrollHost) {
      await this._scrollAndHarvest(scrollHost, harvest);
    } else {
      warnings.push('未找到飞书文档滚动容器，仅导出当前可见内容（长文档可能不完整）。');
      harvest();
    }

    if (blocks.size === 0) {
      // 类名已变化或非 docx 页面：整页兜底
      warnings.push('未识别到飞书 block 结构，已回退到通用提取模式。');
      const fallback = await GenericAdapter.extract();
      fallback.siteName = '飞书文档';
      fallback.warnings = fallback.warnings.concat(warnings);
      return fallback;
    }

    const container = document.createElement('div');
    container.innerHTML = Array.from(blocks.values()).join('\n');
    this._normalize(container, warnings);
    InkIR.fixLazyImages(container);
    InkIR.absolutizeUrls(container);

    return InkIR.create({
      title: this._title(),
      siteName: '飞书文档',
      contentEl: container,
      warnings,
    });
  },

  _findScrollHost() {
    const candidates = [
      '.bear-web-x-container', '.docx-scroller', '.etherpad-container-wrapper',
      '[class*="scroll-container"]', '.doc-content-container',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 50) return el;
    }
    // 退化：找最高的可滚动元素
    let best = null;
    document.querySelectorAll('div').forEach((el) => {
      if (el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 300) {
        if (!best || el.scrollHeight > best.scrollHeight) best = el;
      }
    });
    return best;
  },

  async _scrollAndHarvest(host, harvest) {
    const original = host.scrollTop;
    const step = Math.max(300, host.clientHeight * 0.8);
    host.scrollTop = 0;
    await this._sleep(200);
    let guard = 0;
    while (guard < 400) { // 400 步 ≈ 超长文档保护
      harvest();
      const before = host.scrollTop;
      host.scrollTop = before + step;
      await this._sleep(120); // 等虚拟滚动渲染
      if (host.scrollTop <= before + 1) break; // 到底了
      guard += 1;
      if (guard % 10 === 0 && window.__inkProgress) {
        const pct = Math.min(99, Math.round(host.scrollTop / host.scrollHeight * 100));
        window.__inkProgress(`正在滚动采集长文档 ${pct}%…`);
      }
    }
    harvest();
    host.scrollTop = original;
  },

  _normalize(root, warnings) {
    // 飞书 heading block：div[data-block-type="heading1"] 等 → 真实 h 标签
    for (let level = 1; level <= 6; level++) {
      root.querySelectorAll(`[data-block-type="heading${level}"]`).forEach((el) => {
        const h = document.createElement('h' + level);
        h.textContent = el.textContent.trim();
        el.replaceWith(h);
      });
    }
    // canvas 渲染的嵌入表格：给占位说明，不静默丢失
    let canvasCount = 0;
    root.querySelectorAll('canvas').forEach((c) => {
      canvasCount += 1;
      const p = document.createElement('p');
      p.innerHTML = '<em>[飞书嵌入表格：canvas 渲染，暂不支持导出，请在原文档查看]</em>';
      c.replaceWith(p);
    });
    if (canvasCount > 0) {
      warnings.push(`文档中有 ${canvasCount} 处 canvas 渲染的嵌入表格无法导出，已插入占位说明。`);
    }
    InkIR.removeNoise(root, ['[class*="comment-"]', '[class*="toolbar"]', '[contenteditable] .cursor']);
  },

  _title() {
    const t = document.querySelector('.doc-title, [data-testid="doc-title"], .page-block-header h1');
    if (t && t.textContent.trim()) return t.textContent.trim();
    return document.title.replace(/\s*[-–]\s*(飞书云文档|飞书|Feishu Docs|Lark Docs).*$/i, '').trim();
  },

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  },
};

window.FeishuAdapter = FeishuAdapter;
