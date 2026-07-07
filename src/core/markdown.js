/**
 * 摘墨 · Markdown 转换层
 *
 * 全插件唯一的「IR → Markdown」出口。
 * 所有平台差异都应在适配器层被抹平，这里只面对规范化的 DOM。
 */

const InkMarkdown = {

  /** 构建配置好的 TurndownService（含 GFM 与自定义规则）。style 来自用户设置。 */
  createTurndown(style) {
    const s = style || {};
    const td = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: s.mdBullet || '-',
      codeBlockStyle: 'fenced',
      fence: s.mdFence || '```',
      emDelimiter: s.mdEmphasis || '*',
      strongDelimiter: (s.mdEmphasis || '*') === '_' ? '__' : '**',
      linkStyle: s.mdLinkStyle || 'inlined',
      linkReferenceStyle: 'full',
    });
    td.use(turndownPluginGfm.gfm);

    // 保留换行语义的 <br>（表格内除外，GFM 表格自行处理）
    td.addRule('lineBreak', {
      filter: 'br',
      replacement: (content, node) =>
        node.closest && node.closest('table') ? ' ' : '  \n',
    });

    // <mark> 高亮 → ==text==（Obsidian / Typora 语法）
    td.addRule('highlight', {
      filter: 'mark',
      replacement: (content) => (content.trim() ? `==${content}==` : ''),
    });

    // <kbd> → `key`
    td.addRule('kbd', {
      filter: 'kbd',
      replacement: (content) => '`' + content + '`',
    });

    // 规范化代码块：<pre data-ink-lang="x"> 或 <pre><code class="language-x">
    td.addRule('fencedCodeWithLang', {
      filter: (node) => node.nodeName === 'PRE',
      replacement: (content, node) => {
        let lang = node.getAttribute('data-ink-lang') || '';
        if (!lang) {
          const code = node.querySelector('code');
          const cls = (code ? code.className : '') + ' ' + node.className;
          const m = cls.match(/(?:language|lang|brush:?)[-\s:]?\s*([a-zA-Z0-9#+]+)/);
          if (m) lang = m[1].toLowerCase();
        }
        const codeEl = node.querySelector('code');
        let text = (codeEl || node).textContent || '';
        text = text.replace(/\n$/, '');
        // 尊重用户的围栏偏好；正文里已含围栏字符时自动加长
        const base = s.mdFence || '```';
        const fence = text.includes(base) ? base + base[0] : base;
        return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
      },
    });

    // 统一标注框：<div data-ink-callout="warning" data-ink-title="注意">
    const CALLOUT_BADGE = {
      info: 'ℹ️', note: '📝', warning: '⚠️', error: '🚫', success: '✅', tip: '💡',
    };
    td.addRule('callout', {
      filter: (node) => node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-ink-callout'),
      replacement: (content, node) => {
        const type = node.getAttribute('data-ink-callout') || 'info';
        const title = node.getAttribute('data-ink-title') || '';
        const badge = CALLOUT_BADGE[type] || 'ℹ️';
        const head = `> ${badge} **${title || type.toUpperCase()}**`;
        const body = content.trim().split('\n').map(l => `> ${l}`).join('\n');
        return `\n\n${head}\n>\n${body}\n\n`;
      },
    });

    // <figure> + <figcaption> → 图片 + 斜体说明
    td.addRule('figure', {
      filter: 'figure',
      replacement: (content, node) => {
        const img = node.querySelector('img');
        const cap = node.querySelector('figcaption');
        const alt = (img && img.getAttribute('alt')) || (cap && cap.textContent.trim()) || '';
        const src = img ? img.getAttribute('src') || '' : '';
        const capText = cap ? cap.textContent.trim() : '';
        if (!src) return content;
        return `\n\n![${alt.replace(/[\[\]]/g, '')}](${src})` +
               (capText ? `\n\n*${capText}*` : '') + '\n\n';
      },
    });

    // 复杂表格（prepareTables 标记）：净化后整表输出 HTML，结构零丢失
    td.addRule('complexTableAsHtml', {
      filter: (node) => node.nodeName === 'TABLE' && node.hasAttribute('data-ink-keep-html'),
      replacement: (content, node) => {
        const clone = node.cloneNode(true);
        clone.removeAttribute('data-ink-keep-html');
        // 只保留结构与内容必需的属性，剥掉站点的 class/style/id 噪音
        const KEEP_ATTRS = ['rowspan', 'colspan', 'align', 'src', 'alt', 'href'];
        [clone, ...clone.querySelectorAll('*')].forEach((el) => {
          Array.from(el.attributes).forEach((attr) => {
            if (!KEEP_ATTRS.includes(attr.name)) {
              el.removeAttribute(attr.name);
            } else if ((attr.name === 'href' || attr.name === 'src') &&
                       /^\s*(javascript|vbscript|data\s*:\s*text)/i.test(attr.value)) {
              el.removeAttribute(attr.name); // 危险协议不进导出文件
            }
          });
        });
        return '\n\n' + clone.outerHTML.replace(/>\s+</g, '><') + '\n\n';
      },
    });

    // GFM 单元格：内容里的 | 全部转义为 \|。
    // 这是在「确定属于单元格内容」的作用域里做的，正文中的 | 不受影响。
    // 注意不能在 DOM 阶段预转义——Turndown 会把 \ 再转义成 \\。
    td.addRule('tableCellEscapePipes', {
      filter: (node) =>
        (node.nodeName === 'TH' || node.nodeName === 'TD') &&
        !(node.closest && node.closest('[data-ink-keep-html]')),
      replacement: (content, node) => {
        const safe = content.replace(/\n+/g, ' ').replace(/\|/g, '\\|');
        const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
        return (index === 0 ? '| ' : ' ') + safe.trim() + ' |';
      },
    });

    // 视频 / iframe 嵌入 / 音频：Markdown 无法承载，输出可点击的链接占位，
    // 绝不静默丢弃（数据不丢原则）
    td.addRule('mediaPlaceholder', {
      filter: ['iframe', 'video', 'audio', 'embed'],
      replacement: (content, node) => {
        let src = node.getAttribute('src') || '';
        if (!src && node.querySelector) {
          const source = node.querySelector('source[src]');
          if (source) src = source.getAttribute('src');
        }
        if (!src || src.startsWith('blob:')) return '';
        let abs = src;
        if (abs.startsWith('//')) abs = 'https:' + abs; // 协议相对地址统一按 https
        try { abs = new URL(abs, location.href).href; } catch (e) { /* 保留原值 */ }
        const label = node.getAttribute('title') || node.getAttribute('aria-label') || '';
        const kind = node.nodeName === 'AUDIO' ? '🎵 音频' : '▶️ 视频/嵌入内容';
        return `\n\n[${kind}${label ? '：' + label : ''}](${abs})\n\n`;
      },
    });

    // 公式（restoreMath 的产物）：原样输出 TeX，不做任何转义
    td.addRule('math', {
      filter: (node) => node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-ink-math'),
      replacement: (content, node) => {
        const tex = node.getAttribute('data-ink-math') || '';
        return node.getAttribute('data-ink-display') === '1' ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
      },
    });

    // 丢掉空链接与锚点装饰
    td.addRule('emptyAnchor', {
      filter: (node) => node.nodeName === 'A' && !node.textContent.trim() && !node.querySelector('img'),
      replacement: () => '',
    });

    return td;
  },

  /* ==================== 表格策略 ====================
   *
   * GFM 表格表达能力有限：不支持嵌套表格、rowspan/colspan、块级单元格。
   * 硬转的结果就是结构性丢失或表格碎裂。策略是「先分类，再转换」：
   *
   * 1. GFM 可表达（规则网格 + 有表头）→ 转 GFM；
   *    单元格内的 | 在生成阶段转义为 \|（作用域只在单元格内，
   *    正文里的 | 不受影响——这就是「内容竖线」与「边界竖线」的区分方式；
   *    GFM 规范保证表格单元格中即使 code span 里的 \| 也会还原为 |）。
   * 2. GFM 不可表达（嵌套 / rowspan / colspan / 无表头）→
   *    默认整表保留为净化后的 HTML（GFM、Obsidian、Typora 都原生渲染
   *    HTML 表格），结构零丢失；用户也可在设置里选择「强制扁平化」。
   */

  /** 表格结构是否超出 GFM 的表达能力（无表头可通过表头提升修复，不算复杂） */
  isComplexTable(table) {
    if (table.querySelector('table')) return true;
    if (table.querySelector('[rowspan]:not([rowspan="1"]), [colspan]:not([colspan="1"])')) return true;
    if (!table.querySelector('tr')) return true; // 无行的空表：保留 HTML 最安全
    return false;
  },

  /**
   * 表格预处理入口：
   * - complexTable='html'（默认）：复杂表格打上 data-ink-keep-html 标记，
   *   由专用规则原样输出净化后的 HTML；
   * - complexTable='flatten'：不标记，走扁平化有损降级。
   * 随后对「将转为 GFM 的表格」做单元格扁平化。
   */
  prepareTables(root, opts) {
    const mode = (opts && opts.complexTable) || 'html';
    if (mode === 'html') {
      root.querySelectorAll('table').forEach((table) => {
        if (table.parentElement && table.parentElement.closest('table')) return; // 只标记顶层表格
        if (this.isComplexTable(table)) table.setAttribute('data-ink-keep-html', '1');
      });
    }
    // 表头提升：GFM 表格必须有表头行。对将转 GFM 的无表头表格，把首行 td 提升为 th。
    // 否则 gfm 插件会把整表原样 keep 成未净化的 HTML——既丢转换又留下 XSS 面。
    root.querySelectorAll('table').forEach((table) => {
      if (table.closest('[data-ink-keep-html]')) return;
      const first = table.querySelector('tr');
      if (!first) return;
      Array.from(first.children).forEach((c) => {
        if (c.tagName === 'TD') {
          const th = document.createElement('th');
          th.innerHTML = c.innerHTML;
          c.replaceWith(th);
        }
      });
    });
    this.flattenTableCells(root);
  },

  /**
   * 表格单元格扁平化：GFM 表格不允许单元格里出现块级结构，
   * 这是导出表格「碎掉」的头号原因。把 <p>/<div>/<ul> 等压成 <br> 分隔的行内内容，
   * <pre> 压成行内 <code>。已标记保留 HTML 的表格跳过（结构原样输出）。
   */
  flattenTableCells(root) {
    root.querySelectorAll('td, th').forEach((cell) => {
      if (cell.closest('[data-ink-keep-html]')) return;
      // 代码块 → 行内 code（换行折叠为空格）
      cell.querySelectorAll('pre').forEach((pre) => {
        const code = document.createElement('code');
        code.textContent = pre.textContent.replace(/\s*\n\s*/g, ' ').trim();
        pre.replaceWith(code);
      });
      // 嵌套表格 GFM 无法表达 → 压成文字
      cell.querySelectorAll('table').forEach((t) => {
        const span = document.createElement('span');
        span.textContent = t.textContent.replace(/\s+/g, ' ').trim();
        t.replaceWith(span);
      });
      const blocks = cell.querySelectorAll('p, div, ul, ol, li, h1, h2, h3, h4, h5, h6, blockquote');
      if (!blocks.length) return;
      const parts = [];
      const walk = (node) => {
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === 1 && /^(P|DIV|UL|OL|BLOCKQUOTE|H[1-6])$/.test(child.tagName)) {
            walk(child);
          } else if (child.nodeType === 1 && child.tagName === 'LI') {
            parts.push('• ' + child.innerHTML.trim());
          } else if (child.nodeType === 3 ? child.textContent.trim() : true) {
            parts.push(child.nodeType === 3 ? child.textContent.trim() : child.outerHTML);
          }
        }
      };
      walk(cell);
      cell.innerHTML = parts.filter(Boolean).join('<br>');
    });
  },

  /** YAML Front Matter。值内换行会破坏 YAML 结构，统一压成空格。 */
  buildFrontMatter(ir, opts) {
    const esc = (s) => String(s).replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').trim();
    const lines = ['---'];
    lines.push(`title: "${esc(ir.title)}"`);
    lines.push(`source: "${esc(ir.url)}"`);
    if (ir.byline) lines.push(`author: "${esc(ir.byline)}"`);
    if (ir.siteName) lines.push(`site: "${esc(ir.siteName)}"`);
    if (ir.publishedTime) lines.push(`published: "${esc(ir.publishedTime)}"`);
    lines.push(`clipped: "${new Date().toISOString()}"`);
    const tags = String((opts && opts.frontMatterTags) || 'clippings')
      .split(/[,，]/).map(t => t.trim()).filter(Boolean);
    if (tags.length) lines.push(`tags: [${tags.join(', ')}]`);
    lines.push('---');
    return lines.join('\n');
  },

  /**
   * 划线评论 → 高亮 + 脚注：在正文中找到 anchorText 首次出现的位置，
   * 把被划线的原文包成 ==高亮==（可选，Obsidian/Typora 语法），并追加 [^n] 脚注。
   * 读者在正文里能直接看到「哪段被划过」，评论内容在脚注里。
   * 找不到锚点的划线评论会降级到文末评论区，绝不丢失。
   */
  weaveInlineFootnotes(markdown, inlineAnnotations, opts) {
    const footnotes = [];
    const orphans = [];
    const highlight = !opts || opts.highlightAnchors !== false;
    let counter = 0;

    for (const ann of inlineAnnotations) {
      const anchor = (ann.anchorText || '').trim();
      let placed = false;
      if (anchor && anchor.length >= 2) {
        // 只在正文行中搜索，跳过代码块
        const idx = InkMarkdown._indexOutsideCode(markdown, anchor);
        if (idx !== -1) {
          counter += 1;
          const woven = highlight
            ? `==${anchor}==[^${counter}]`
            : `${anchor}[^${counter}]`;
          markdown = markdown.slice(0, idx) + woven + markdown.slice(idx + anchor.length);
          const noteBody = InkMarkdown._formatAnnotationBody(ann);
          footnotes.push(`[^${counter}]: ${noteBody}`);
          placed = true;
        }
      }
      if (!placed) orphans.push(ann);
    }

    if (footnotes.length) {
      markdown += '\n\n' + footnotes.join('\n');
    }
    return { markdown, orphans };
  },

  _indexOutsideCode(markdown, needle) {
    // 粗粒度：按 fenced code 分段，只在非代码段查找
    const parts = markdown.split(/(```[\s\S]*?```)/);
    let offset = 0;
    for (const part of parts) {
      if (!part.startsWith('```')) {
        const i = part.indexOf(needle);
        if (i !== -1) return offset + i;
      }
      offset += part.length;
    }
    return -1;
  },

  _formatAnnotationBody(ann) {
    const meta = [ann.author, ann.time].filter(Boolean).join(' · ');
    let body = ann.content.replace(/\n+/g, ' ').trim();
    if (meta) body = `**${meta}**：${body}`;
    for (const r of ann.replies) {
      const rMeta = [r.author, r.time].filter(Boolean).join(' · ');
      body += ` ↳ ${rMeta ? `**${rMeta}**：` : ''}${r.content.replace(/\n+/g, ' ').trim()}`;
    }
    return body;
  },

  /** 页面评论 + 无锚点的划线评论 → 文末评论区 */
  buildCommentAppendix(annotations) {
    if (!annotations.length) return '';
    const lines = ['', '---', '', '## 💬 评论', ''];
    for (const ann of annotations) {
      const meta = [ann.author, ann.time].filter(Boolean).join(' · ');
      if (ann.kind === 'inline' && ann.anchorText) {
        lines.push(`> 📌 划线：「${ann.anchorText.trim().slice(0, 80)}」`);
        lines.push('>');
      }
      lines.push(`> ${meta ? `**${meta}**` : ''}`);
      ann.content.trim().split('\n').forEach(l => lines.push(`> ${l}`));
      for (const r of ann.replies) {
        const rMeta = [r.author, r.time].filter(Boolean).join(' · ');
        lines.push('>');
        lines.push(`> > ${rMeta ? `**${rMeta}**` : ''}`);
        r.content.trim().split('\n').forEach(l => lines.push(`> > ${l}`));
      }
      lines.push('');
    }
    return lines.join('\n');
  },

  /**
   * 主入口：IR + 选项 → 完整 Markdown 文本
   * options: {
   *   frontMatter: boolean,
   *   includeComments: boolean,
   *   commentStyle: 'footnote' | 'appendix' | 'both',
   *   includeTitle: boolean,
   * }
   */
  render(ir, options) {
    const opts = Object.assign({
      frontMatter: true,
      includeComments: true,
      commentStyle: 'both',
      highlightAnchors: true,
      includeTitle: true,
    }, options);

    // 在克隆上做表格预处理：同一份 IR 缓存可以用不同设置反复导出，互不污染
    let workEl = null;
    if (ir.contentEl) {
      workEl = ir.contentEl.cloneNode(true);
      this.prepareTables(workEl, opts);
    }
    const td = this.createTurndown(opts);
    let body = td.turndown(workEl ? workEl.innerHTML : '');
    // 清理不可见字符（零宽空格/BOM/方向控制符）与 nbsp，收敛多余空行
    body = body
      .replace(/[\u200b\u200c\u200d\u200e\u200f\ufeff]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    let appendixAnns = [];
    if (opts.includeComments && ir.annotations.length) {
      const inline = ir.annotations.filter(a => a.kind === 'inline');
      const page = ir.annotations.filter(a => a.kind === 'page');

      if (opts.commentStyle === 'footnote' || opts.commentStyle === 'both') {
        const woven = this.weaveInlineFootnotes(body, inline, opts);
        body = woven.markdown;
        appendixAnns = woven.orphans.concat(page);
      } else {
        // appendix 模式：全部评论（含划线）汇入文末评论区，绝不静默丢数据
        appendixAnns = inline.concat(page);
      }
    }

    const pieces = [];
    if (opts.frontMatter) pieces.push(this.buildFrontMatter(ir));
    if (opts.includeTitle) pieces.push(`# ${ir.title}`);
    pieces.push(body);
    if (appendixAnns.length) {
      pieces.push(this.buildCommentAppendix(appendixAnns));
    }

    return pieces.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';
  },
};

window.InkMarkdown = InkMarkdown;
