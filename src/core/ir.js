/**
 * 摘墨 · 中间表示层（Intermediate Representation）
 *
 * 所有适配器的产出、所有导出器的输入，都是同一个 IR 结构。
 * 适配器只负责「网页 → IR」，Markdown 转换只发生在「IR → md」这一处。
 *
 * IR 结构：
 * {
 *   title:       string          文档标题
 *   byline:      string|null     作者
 *   siteName:    string|null     站点名
 *   url:         string          来源地址
 *   excerpt:     string|null     摘要
 *   publishedTime: string|null   发布时间（ISO 或原始文本）
 *   contentEl:   Element         规范化后的正文 DOM（游离节点，已清洗）
 *   annotations: Annotation[]    评论/划线（见下）
 *   warnings:    string[]        提取过程中的告警（展示给用户）
 * }
 *
 * Annotation 结构：
 * {
 *   kind:       'inline' | 'page'   划线评论 or 页面评论
 *   anchorText: string|null         inline 评论锚定的原文片段
 *   author:     string|null
 *   time:       string|null
 *   content:    string              评论正文（纯文本或简单 markdown）
 *   replies:    Annotation[]
 * }
 */

const InkIR = {
  create(partial) {
    return Object.assign({
      title: document.title || '未命名文档',
      byline: null,
      siteName: null,
      url: location.href.split('#')[0],
      excerpt: null,
      publishedTime: null,
      contentEl: null,
      annotations: [],
      warnings: [],
    }, partial);
  },

  annotation(partial) {
    return Object.assign({
      kind: 'page',
      anchorText: null,
      author: null,
      time: null,
      content: '',
      replies: [],
    }, partial);
  },

  /* ---------- DOM 规范化工具（供各适配器复用） ---------- */

  /** 深拷贝一个节点，返回可自由改写的游离副本 */
  detach(el) {
    return el.cloneNode(true);
  },

  /** 修复懒加载图片：data-src / data-original / data-actualsrc → src */
  fixLazyImages(root) {
    const LAZY_ATTRS = ['data-src', 'data-original', 'data-actualsrc', 'data-lazy-src', 'data-real-src'];
    root.querySelectorAll('img').forEach((img) => {
      for (const attr of LAZY_ATTRS) {
        const v = img.getAttribute(attr);
        if (v && (!img.getAttribute('src') || img.src.startsWith('data:image/gif') || img.src.startsWith('data:image/svg'))) {
          img.setAttribute('src', v);
          break;
        }
      }
      // srcset 中挑最大的一张兜底
      if (!img.getAttribute('src') && img.getAttribute('srcset')) {
        const candidates = img.getAttribute('srcset').split(',').map(s => s.trim().split(/\s+/)[0]);
        if (candidates.length) img.setAttribute('src', candidates[candidates.length - 1]);
      }
    });
  },

  /** 把所有资源链接绝对化（游离节点里的相对路径会丢上下文） */
  absolutizeUrls(root, baseUrl) {
    const base = baseUrl || location.href;
    root.querySelectorAll('img[src]').forEach((img) => {
      try { img.setAttribute('src', new URL(img.getAttribute('src'), base).href); } catch (e) { /* 保留原值 */ }
    });
    root.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('mailto:')) {
        try { a.setAttribute('href', new URL(href, base).href); } catch (e) { /* 保留原值 */ }
      }
    });
  },

  /** 移除噪音节点：脚本、样式、隐藏元素、常见装饰性控件 */
  removeNoise(root, extraSelectors) {
    const NOISE = [
      'script', 'style', 'link', 'noscript', 'iframe[src*="ads"]',
      'button', '[role="tooltip"]', '[aria-hidden="true"] svg',
      '.inkmark-ignore',
    ].concat(extraSelectors || []);
    NOISE.forEach((sel) => {
      try { root.querySelectorAll(sel).forEach(n => n.remove()); } catch (e) { /* 无效选择器忽略 */ }
    });
  },

  /**
   * 规范化标注框（callout / admonition）。
   * 适配器把平台特有的提示面板改写成统一结构：
   *   <div data-ink-callout="info|note|warning|error|success" data-ink-title="...">正文</div>
   * markdown.js 里有对应的转换规则。
   */
  markCallout(el, type, title) {
    el.setAttribute('data-ink-callout', type || 'info');
    if (title) el.setAttribute('data-ink-title', title);
  },

  /**
   * 规范化代码块。适配器把平台特有的代码宏改写成：
   *   <pre data-ink-lang="java"><code>...</code></pre>
   */
  markCodeBlock(preEl, lang) {
    if (lang) preEl.setAttribute('data-ink-lang', lang.toLowerCase());
  },

  /** 统计信息，popup 用来展示 */
  stats(ir) {
    const root = ir.contentEl;
    const text = root ? (root.textContent || '') : '';
    return {
      words: (text.match(/[一-龥]/g) || []).length +
             (text.replace(/[一-龥]/g, ' ').match(/[a-zA-Z0-9_]+/g) || []).length,
      images: root ? root.querySelectorAll('img').length : 0,
      tables: root ? root.querySelectorAll('table').length : 0,
      codeBlocks: root ? root.querySelectorAll('pre').length : 0,
      comments: ir.annotations.length +
                ir.annotations.reduce((n, a) => n + a.replies.length, 0),
    };
  },
};

window.InkIR = InkIR;
