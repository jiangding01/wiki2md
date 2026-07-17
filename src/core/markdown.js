/**
 * 摘墨 · Markdown 转换层
 *
 * 全插件唯一的「IR → Markdown」出口。
 * 所有平台差异都应在适配器层被抹平，这里只面对规范化的 DOM。
 */

// 幂等声明：重复注入时复用首次实例（const 重声明会抛错；裸 var 重建会清空注册表等内部状态）
var InkMarkdown = window.InkMarkdown || {

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
      // 纵深防御：gfm 插件会把它认不出表头的表格整表 keep——被 keep 的
      // TABLE 一律过同款净化再输出，「未净化 HTML」这个出口彻底封死
      // （站点 class/style/data-* 噪音与 XSS 面都不再漏出）
      keepReplacement: (content, node) =>
        node.nodeName === 'TABLE'
          ? '\n\n' + InkMarkdown._sanitizedTableHtml(node) + '\n\n'
          : (node.isBlock ? '\n\n' + node.outerHTML + '\n\n' : node.outerHTML),
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
        // 尊重用户的围栏偏好；围栏必须比正文中最长的同字符连串更长，
        // 否则内容里 4+ 个反引号会提前闭合代码块
        const marker = (s.mdFence || '```')[0];
        const runs = text.match(new RegExp(`[${marker}]{3,}`, 'g'));
        const maxRun = runs ? Math.max(...runs.map(r => r.length)) : 0;
        const fence = marker.repeat(Math.max(3, maxRun + 1));
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
      replacement: (content, node) =>
        '\n\n' + InkMarkdown._sanitizedTableHtml(node) + '\n\n',
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
        let src = node.getAttribute('src') || node.getAttribute('data-src') || '';
        if (!src && node.querySelector) {
          const source = node.querySelector('source[src]');
          if (source) src = source.getAttribute('src');
        }
        if (src.startsWith('blob:')) {
          // blob 流无法外链，但也不能无声消失
          return '\n\n*[▶️ 媒体内容：blob 流，无法导出外链，请在原页面查看]*\n\n';
        }
        if (!src) return '';
        let abs = src;
        if (abs.startsWith('//')) abs = 'https:' + abs; // 协议相对地址统一按 https
        try { abs = new URL(abs, location.href).href; } catch (e) { /* 保留原值 */ }
        // iframe/video/audio 不经过 absolutizeUrls（它只扫 img/a），括号转义在此补齐
        abs = InkIR.escapeUrlParens(abs);
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

  /** 表格 HTML 净化（complexTableAsHtml 与 keepReplacement 共用唯一实现）：
   *  只保留结构与内容必需的属性，剥掉站点的 class/style/data-* 噪音，
   *  href/src 的危险协议不进导出文件。 */
  _sanitizedTableHtml(node) {
    const clone = node.cloneNode(true);
    clone.removeAttribute('data-ink-keep-html');
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
    return clone.outerHTML.replace(/>\s+</g, '><');
  },

  /** 表格结构是否超出 GFM 的表达能力（无表头可通过表头提升修复，不算复杂） */
  isComplexTable(table) {
    if (table.querySelector('table')) return true;
    if (table.querySelector('[rowspan]:not([rowspan="1"]), [colspan]:not([colspan="1"])')) return true;
    if (!table.querySelector('tr')) return true; // 无行的空表：保留 HTML 最安全
    return false;
  },

  /** 本表自身（不含嵌套内层表）是否有合并单元格 */
  _hasSpannedCells(table) {
    return Array.from(table.rows).some(row =>
      Array.from(row.cells).some(c => (c.rowSpan || 1) > 1 || (c.colSpan || 1) > 1)
    );
  },

  /**
   * 合并单元格网格展开（源自用户 v1 插件 tableNormalize 的实战方案）：
   * 把 rowspan/colspan 展开成规则矩形网格——合并格内容落在首格，
   * 其余跨越位置补空格。展开后的表格是规则网格，可以转 GFM，
   * 这是把「大量 HTML 表格」降到最少的关键一步。
   */
  normalizeTableGrid(table) {
    const rows = Array.from(table.rows);
    if (!rows.length) return;
    const grid = [];
    rows.forEach((row, r) => {
      grid[r] = grid[r] || [];
      let cIndex = 0;
      Array.from(row.cells).forEach((cell) => {
        while (grid[r][cIndex]) cIndex++;
        const rs = cell.rowSpan || 1;
        const cs = cell.colSpan || 1;
        const first = cell.cloneNode(true);
        first.removeAttribute('rowspan');
        first.removeAttribute('colspan');
        grid[r][cIndex] = first;
        for (let i = 0; i < rs; i++) {
          for (let j = 0; j < cs; j++) {
            if (i === 0 && j === 0) continue;
            grid[r + i] = grid[r + i] || [];
            grid[r + i][cIndex + j] = document.createElement(cell.tagName);
          }
        }
        cIndex += cs;
      });
    });
    const tbody = document.createElement('tbody');
    grid.forEach((gridRow) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < gridRow.length; c++) {
        tr.appendChild(gridRow[c] || document.createElement('td'));
      }
      tbody.appendChild(tr);
    });
    table.innerHTML = '';
    table.appendChild(tbody);
  },

  /**
   * 表格预处理入口：
   * - complexTable='html'（默认）：复杂表格打上 data-ink-keep-html 标记，
   *   由专用规则原样输出净化后的 HTML；
   * - complexTable='flatten'：不标记，走扁平化有损降级。
   * 随后对「将转为 GFM 的表格」做单元格扁平化。
   */
  prepareTables(root, opts) {
    const mode = (opts && opts.complexTable) || 'auto';

    // 第一步：决定哪些表格保留 HTML
    root.querySelectorAll('table').forEach((table) => {
      if (table.parentElement && table.parentElement.closest('table')) return; // 只看顶层表格
      if (mode === 'html') {
        // 保守模式：任何 GFM 表达不了的结构都原样保留
        if (this.isComplexTable(table)) table.setAttribute('data-ink-keep-html', '1');
      } else if (mode === 'auto') {
        // 智能模式（默认）：只有嵌套表格保留 HTML，合并单元格走网格展开
        if (table.querySelector('table') || !table.querySelector('tr')) {
          table.setAttribute('data-ink-keep-html', '1');
        }
      }
      // flatten 模式：什么都不保留，全部降级为纯 Markdown
    });

    // 第二步：对将转 GFM 的表格展开合并单元格（auto/flatten 模式）
    if (mode !== 'html') {
      root.querySelectorAll('table').forEach((table) => {
        if (table.closest('[data-ink-keep-html]')) return;
        if (this._hasSpannedCells(table)) this.normalizeTableGrid(table);
      });
    }
    // 表头规范化：GFM 表格必须有插件「认得出」的表头行，否则整表被原样
    // keep 成未净化 HTML——既丢转换又留下噪音与 XSS 面。三步：
    // 1. 删 colgroup/col：对 md 无意义，且它排在 tbody 前面会让 gfm 插件的
    //    isFirstTbody 判定失败（tbody 的前兄弟不是空 thead）——Confluence
    //    表格自带列宽 colgroup，真实案例里规则表格因此整表漏净化；
    // 2. 无表头的把首行 td 提升为 th；
    // 3. 首行全 th 时显式包进 <thead>：命中插件判表头的 THEAD 分支，
    //    不再依赖「tbody 必须是第一个孩子」这类脆弱的结构位置判定。
    root.querySelectorAll('table').forEach((table) => {
      if (table.closest('[data-ink-keep-html]')) return;
      table.querySelectorAll('colgroup, col').forEach(n => n.remove());
      const first = table.querySelector('tr');
      if (!first) return;
      Array.from(first.children).forEach((c) => {
        if (c.tagName === 'TD') {
          const th = document.createElement('th');
          th.innerHTML = c.innerHTML;
          c.replaceWith(th);
        }
      });
      if (first.parentElement && first.parentElement.tagName !== 'THEAD' &&
          Array.from(first.children).every(c => c.tagName === 'TH')) {
        const thead = document.createElement('thead');
        table.insertBefore(thead, table.firstChild);
        thead.appendChild(first);
      }
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

  /**
   * 合并紧邻的同类强调元素：<strong>a</strong><strong>b</strong>（中间无任何
   * 文本节点）会被 Turndown 输出成 `**a****b**`——四连星号在渲染器里解析错乱。
   * 富文本编辑器（微信公众号等）常把一句话按样式段拆成多个 strong，此处在
   * DOM 层合并，对所有站点生效。
   */
  mergeAdjacentEmphasis(root) {
    root.querySelectorAll('strong, b, em, i').forEach((el) => {
      const prev = el.previousSibling;
      if (prev && prev.nodeType === 1 && prev.tagName === el.tagName) {
        while (el.firstChild) prev.appendChild(el.firstChild);
        el.remove();
      }
    });
  },

  /** YAML Front Matter。值内换行会破坏 YAML 结构，统一压成空格。
   *  反斜杠必须最先转义——标题以 \ 结尾时会吃掉闭合引号，front matter 直接损坏。 */
  buildFrontMatter(ir, opts) {
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').trim();
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
    // 编号避让：原文可能自带 [^n] 脚注（技术文章常见），
    // 从其最大编号之后接着编，绝不与正文既有脚注冲突
    let counter = 0;
    for (const m of markdown.matchAll(/\[\^(\d+)\]/g)) {
      counter = Math.max(counter, Number(m[1]));
    }

    for (const ann of inlineAnnotations) {
      // 锚点与正文做同款不可见字符归一，否则含 nbsp/零宽字符的划线必然失配
      const anchor = (ann.anchorText || '')
        .replace(/[\u200b\u200c\u200d\u200e\u200f\ufeff]/g, '')
        .replace(/\u00a0/g, ' ')
        .trim();
      let placed = false;
      if (anchor && anchor.length >= 2) {
        // 只在正文行中搜索，跳过代码块；含转义/跨空白的原文走模糊匹配
        const hit = InkMarkdown._findAnchor(markdown, anchor);
        if (hit) {
          counter += 1;
          // 用命中的 md 原片段做展示文本（保留 Turndown 转义，渲染不变形）；
          // 跨行命中不加 == 高亮——高亮语法不能跨块
          const shown = markdown.slice(hit.index, hit.index + hit.length);
          const woven = highlight && !shown.includes('\n')
            ? `==${shown}==[^${counter}]`
            : `${shown}[^${counter}]`;
          markdown = markdown.slice(0, hit.index) + woven + markdown.slice(hit.index + hit.length);
          const noteBody = InkMarkdown._formatAnnotationBody(ann);
          footnotes.push(`[^${counter}]: ${noteBody}`);
          placed = true;
        }
      }
      if (!placed) orphans.push(ann);
    }

    if (footnotes.length) {
      // 脚注定义之间空一行：多行脚注（缩进续行）后紧贴下一条定义，部分渲染器会解析粘连
      markdown += '\n\n' + footnotes.join('\n\n');
    }
    return { markdown, orphans };
  },

  /** fenced code 围栏行（``` / ~~~，可缩进 ≤3 空格，长度 ≥3） */
  _fenceRe: /^ {0,3}([`~]{3,})/,

  /**
   * 围栏感知的正文清洗：零宽字符/BOM 删除、nbsp→空格、连续空行收敛。
   * 逐行扫描并跳过 fenced code 内部——代码内容一个字符都不改
   * （nbsp/零宽字符/连续空行在代码里可能是有意为之的内容）。
   */
  _cleanupOutsideCode(text) {
    const out = [];
    let fence = null; // 当前所在围栏的开栏标记；闭栏需同字符且不短于它
    let blanks = 0;
    for (const line of text.split('\n')) {
      const m = line.match(this._fenceRe);
      if (fence) {
        out.push(line);
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
        continue;
      }
      if (m) {
        fence = m[1];
        blanks = 0;
        out.push(line);
        continue;
      }
      const cleaned = line
        .replace(/[\u200b\u200c\u200d\u200e\u200f\ufeff]/g, '')
        .replace(/\u00a0/g, ' ');
      if (!cleaned.trim()) {
        blanks += 1;
        if (blanks > 1) continue; // 连续空行只留一个（等价于 \n{3,} → \n\n）
        out.push('');
      } else {
        blanks = 0;
        out.push(cleaned);
      }
    }
    return out.join('\n').trim();
  },

  /**
   * 把 markdown 切成 fenced code 之外的文本段 [{ offset, text }]。
   * 线性扫描围栏状态而非按 ``` 成对 split——奇数个围栏（未闭合代码块）
   * 时成对切分会把末段代码误判为正文。段内保留原始换行，跨行锚点可匹配。
   */
  _textSegments(markdown) {
    const segs = [];
    let fence = null;
    let pos = 0;
    let cur = null; // 当前文本段 { offset, end }
    for (const line of markdown.split('\n')) {
      const m = line.match(this._fenceRe);
      if (fence) {
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
        cur = null;
      } else if (m) {
        fence = m[1];
        cur = null;
      } else {
        if (!cur) { cur = { offset: pos, end: pos }; segs.push(cur); }
        cur.end = pos + line.length;
      }
      pos += line.length + 1; // 含换行符
    }
    return segs.map(s => ({ offset: s.offset, text: markdown.slice(s.offset, s.end) }));
  },

  _indexOutsideCode(markdown, needle) {
    for (const seg of this._textSegments(markdown)) {
      const i = seg.text.indexOf(needle);
      if (i !== -1) return seg.offset + i;
    }
    return -1;
  },

  /**
   * 在非代码区定位锚点原文，返回 { index, length } 或 null。
   * 快路径：原文精确出现。慢路径「转义感知」：Turndown 会把 * _ [ ] 等
   * 转义成 \*，锚点里的空白在 md 里可能变成换行/多空格——含特殊字符的
   * 划线原文此前必然失配降级附录，这是锚定命中率的主要流失点。
   */
  _findAnchor(markdown, anchor) {
    const exact = this._indexOutsideCode(markdown, anchor);
    if (exact !== -1) return { index: exact, length: anchor.length };

    const words = anchor.split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const re = new RegExp(words.map(w =>
      w.split('').map(ch => '\\\\?' + ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
    ).join('\\s+'));
    for (const seg of this._textSegments(markdown)) {
      const m = seg.text.match(re);
      if (m) return { index: seg.offset + m.index, length: m[0].length };
    }
    return null;
  },

  /** 脚注体：首行评论，回复逐行缩进（4 空格续行是多行脚注语法，Obsidian/Typora/GFM 通用）。
   *  行尾两个空格是硬换行——没有它，段落内换行会被渲染器合并回一行（软换行），
   *  回复链就又挤成一坨（真机反馈两轮才踩全的坑）。 */
  _formatAnnotationBody(ann) {
    const meta = [ann.author, ann.time].filter(Boolean).join(' · ');
    let body = ann.content.replace(/\n+/g, ' ').trim();
    if (meta) body = `**${meta}**：${body}`;
    const lines = [body];
    for (const r of ann.replies) {
      const rMeta = [r.author, r.time].filter(Boolean).join(' · ');
      lines.push(`↳ ${rMeta ? `**${rMeta}**：` : ''}${r.content.replace(/\n+/g, ' ').trim()}`);
    }
    return lines.join('  \n    ');
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
      this.mergeAdjacentEmphasis(workEl);
      this.prepareTables(workEl, opts);
    }
    const td = this.createTurndown(opts);
    // 直接传 DOM 节点：innerHTML 序列化 + Turndown 内部再解析是两份多余的全量拷贝
    let body = td.turndown(workEl || '');
    // 清理不可见字符（零宽空格/BOM/方向控制符）与 nbsp，收敛多余空行——
    // 围栏感知，fenced code 内部原样保留
    body = this._cleanupOutsideCode(body);

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
    if (opts.frontMatter) pieces.push(this.buildFrontMatter(ir, opts));
    // 标题内部空白压平：源页标题元素可能含换行缩进，H1 断行后
    // 第二行会被渲染器当成正文（如「- PRD」变列表项）
    if (opts.includeTitle) pieces.push(`# ${String(ir.title).replace(/\s+/g, ' ').trim()}`);
    pieces.push(body);
    if (appendixAnns.length) {
      pieces.push(this.buildCommentAppendix(appendixAnns));
    }

    // 末次空行收敛同样要绕开代码块（body 里有 fenced code）
    return this._cleanupOutsideCode(pieces.filter(Boolean).join('\n\n')) + '\n';
  },
};

window.InkMarkdown = InkMarkdown;
