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

// 幂等声明：重复注入时复用首次实例（const 重声明会抛错；裸 var 重建会清空注册表等内部状态）
var InkIR = window.InkIR || {
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

  /** URL 字面括号 → %28/%29（百分号编码语义等价）：
   *  md 内联链接 `](url)` 里未转义的 ) 会提前闭合链接，
   *  图片本地化的收集正则也会在此截断。
   *  所有产出 URL 的路径（absolutizeUrls / markdown 媒体占位规则）共用本实现。 */
  escapeUrlParens(u) {
    return String(u).replace(/\(/g, '%28').replace(/\)/g, '%29');
  },

  /** 把所有资源链接绝对化（游离节点里的相对路径会丢上下文），
   *  顺带做括号转义（见 escapeUrlParens）。 */
  absolutizeUrls(root, baseUrl) {
    const base = baseUrl || location.href;
    const escapeParens = (u) => this.escapeUrlParens(u);
    root.querySelectorAll('img[src]').forEach((img) => {
      try { img.setAttribute('src', escapeParens(new URL(img.getAttribute('src'), base).href)); } catch (e) { /* 保留原值 */ }
    });
    root.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;
      // 危险协议直接摘除（javascript:/vbscript:/data:）——
      // 它们会进入导出的 .md，在任何渲染器里都是攻击载荷
      if (/^\s*(javascript|vbscript|data)\s*:/i.test(href)) {
        a.removeAttribute('href');
        return;
      }
      try { a.setAttribute('href', escapeParens(new URL(href, base).href)); } catch (e) { /* 保留原值 */ }
    });
  },

  /** 移除噪音节点：脚本、样式、隐藏元素、常见装饰性控件 */
  removeNoise(root, extraSelectors) {
    const NOISE = [
      // math/tex 脚本是 MathJax 公式源码，restoreMath 需要它，必须豁免
      'script:not([type^="math/tex"])', 'style', 'link', 'noscript', 'iframe[src*="ads"]',
      'button', '[role="tooltip"]', '[aria-hidden="true"] svg',
      '.inkmark-ignore',
    ].concat(extraSelectors || []);
    NOISE.forEach((sel) => {
      try { root.querySelectorAll(sel).forEach(n => n.remove()); } catch (e) { /* 无效选择器忽略 */ }
    });
  },

  /**
   * 标准清洗序列：懒加载修复 → 噪音清理 → URL 绝对化。
   * 顺序是隐性契约：fixLazyImages 必须先于 absolutizeUrls，
   * 否则 data-src 里的相对路径不会被绝对化。所有适配器统一走这里，不再各自手拼。
   * （自行拼装 container 的适配器——如 Stack Overflow——也走这里，只跳过克隆一步。）
   */
  normalizeContainer(container, extraNoise, baseUrl) {
    this.fixLazyImages(container);
    this.removeNoise(container, extraNoise);
    this.absolutizeUrls(container, baseUrl);
    return container;
  },

  /** 选择器型适配器的标准提取序列：克隆 + 标准清洗 */
  buildContainer(sourceEl, extraNoise, baseUrl) {
    const container = document.createElement('div');
    container.appendChild(this.detach(sourceEl));
    return this.normalizeContainer(container, extraNoise, baseUrl);
  },

  /** 标题兜底链：选择器命中非空文本即用，否则 document.title（可剥站点后缀） */
  pickTitle(selector, stripSuffixRe) {
    if (selector) {
      const el = document.querySelector(selector);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    let t = document.title || '未命名文档';
    if (stripSuffixRe) t = t.replace(stripSuffixRe, '').trim();
    return t || '未命名文档';
  },

  /** 可选文本读取：命中且非空返回 trim 后文本，否则 null */
  pickText(selector) {
    const el = selector ? document.querySelector(selector) : null;
    const t = el && el.textContent ? el.textContent.trim() : '';
    return t || null;
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

  /**
   * 还原数学公式：把 KaTeX / MathJax v2 渲染结果还原为 $LaTeX$ 源码。
   * 产出 <span data-ink-math> 标记元素（而非文本节点）——
   * Turndown 会转义文本里的反斜杠，专用元素 + 专用规则才能原样输出 TeX。
   */
  restoreMath(root) {
    const mathEl = (tex, display) => {
      const el = document.createElement('span');
      el.setAttribute('data-ink-math', tex);
      if (display) el.setAttribute('data-ink-display', '1');
      // 必须有文本内容：空元素会被 Readability 的清理逻辑移除
      el.textContent = tex;
      return el;
    };
    // KaTeX 块级公式（先于行内处理，内部包含 .katex）
    root.querySelectorAll('.katex-display').forEach((el) => {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      if (ann) el.replaceWith(mathEl(ann.textContent.trim(), true));
    });
    root.querySelectorAll('.katex').forEach((el) => {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      if (ann) el.replaceWith(mathEl(ann.textContent.trim(), false));
    });
    // MathJax v2：源码在 <script type="math/tex">，渲染节点是冗余的
    const scripts = root.querySelectorAll('script[type^="math/tex"]');
    if (scripts.length) {
      scripts.forEach((s) => {
        const display = (s.getAttribute('type') || '').includes('display');
        s.replaceWith(mathEl(s.textContent.trim(), display));
      });
      root.querySelectorAll('.MathJax, .MathJax_Preview, .MathJax_Display, .MathJax_CHTML, .MathJax_SVG')
        .forEach(n => n.remove());
    }
  },

  /** 统计信息，popup 用来展示。
   *  字数单趟按码位计数（CJK 每字一词、英数下划线连串一词）——
   *  正则 match 会为百万字文档物化百万个单字符字符串，这里零中间分配。 */
  stats(ir) {
    const root = ir.contentEl;
    let words = 0;
    if (root) {
      const text = root.textContent || '';
      let inWord = false;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        // CJK 基本区+扩展A+兼容区、日文假名、谚文——每字计一词
        if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) ||
            (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3040 && c <= 0x30ff) ||
            (c >= 0xac00 && c <= 0xd7a3)) {
          words += 1;
          inWord = false;
        } else if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) {
          if (!inWord) { words += 1; inWord = true; }
        } else {
          inWord = false;
        }
      }
    }
    let images = 0, tables = 0, codeBlocks = 0;
    if (root) {
      // localName 而非 tagName：XHTML 文档里 tagName 保持小写，大写比较会全部误判
      root.querySelectorAll('img, table, pre').forEach((el) => {
        if (el.localName === 'img') images += 1;
        else if (el.localName === 'table') tables += 1;
        else codeBlocks += 1;
      });
    }
    return {
      words, images, tables, codeBlocks,
      comments: ir.annotations.length +
                ir.annotations.reduce((n, a) => n + a.replies.length, 0),
    };
  },
};

window.InkIR = InkIR;
