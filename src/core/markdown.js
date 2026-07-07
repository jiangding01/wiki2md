/**
 * 摘墨 · Markdown 转换层
 *
 * 全插件唯一的「IR → Markdown」出口。
 * 所有平台差异都应在适配器层被抹平，这里只面对规范化的 DOM。
 */

const InkMarkdown = {

  /** 构建配置好的 TurndownService（含 GFM 与自定义规则） */
  createTurndown() {
    const td = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      fence: '```',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
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
        const fence = text.includes('```') ? '````' : '```';
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

    // 丢掉空链接与锚点装饰
    td.addRule('emptyAnchor', {
      filter: (node) => node.nodeName === 'A' && !node.textContent.trim() && !node.querySelector('img'),
      replacement: () => '',
    });

    return td;
  },

  /** YAML Front Matter */
  buildFrontMatter(ir) {
    const esc = (s) => String(s).replace(/"/g, '\\"');
    const lines = ['---'];
    lines.push(`title: "${esc(ir.title)}"`);
    lines.push(`source: "${esc(ir.url)}"`);
    if (ir.byline) lines.push(`author: "${esc(ir.byline)}"`);
    if (ir.siteName) lines.push(`site: "${esc(ir.siteName)}"`);
    if (ir.publishedTime) lines.push(`published: "${esc(ir.publishedTime)}"`);
    lines.push(`clipped: "${new Date().toISOString()}"`);
    lines.push('tags: [clippings]');
    lines.push('---');
    return lines.join('\n');
  },

  /**
   * 划线评论 → 脚注：在正文中找到 anchorText 首次出现的位置，插入 [^n]
   * 找不到锚点的划线评论会降级到文末评论区。
   */
  weaveInlineFootnotes(markdown, inlineAnnotations) {
    const footnotes = [];
    const orphans = [];
    let counter = 0;

    for (const ann of inlineAnnotations) {
      const anchor = (ann.anchorText || '').trim();
      let placed = false;
      if (anchor && anchor.length >= 2) {
        // 只在正文行中搜索，跳过代码块
        const idx = InkMarkdown._indexOutsideCode(markdown, anchor);
        if (idx !== -1) {
          counter += 1;
          const at = idx + anchor.length;
          markdown = markdown.slice(0, at) + `[^${counter}]` + markdown.slice(at);
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
      includeTitle: true,
    }, options);

    const td = this.createTurndown();
    let body = td.turndown(ir.contentEl ? ir.contentEl.innerHTML : '');
    // 收敛多余空行
    body = body.replace(/\n{3,}/g, '\n\n').trim();

    let appendixAnns = [];
    if (opts.includeComments && ir.annotations.length) {
      const inline = ir.annotations.filter(a => a.kind === 'inline');
      const page = ir.annotations.filter(a => a.kind === 'page');

      if (opts.commentStyle === 'footnote' || opts.commentStyle === 'both') {
        const woven = this.weaveInlineFootnotes(body, inline);
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
