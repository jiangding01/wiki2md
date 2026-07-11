/**
 * 摘墨 · 预览页锚点级同步滚动 —— 核心映射算法（纯函数，不依赖 DOM / chrome API）
 *
 * 背景：旧版双栏同步滚动是「滚动条高度比例」换算，长文档里源码与渲染区域
 * 经常对不上同一段落。这里改成基于 marked 的 token 流建立「源码行号区间
 * ↔ 渲染出的第几个顶层块」映射，preview.js 拿这份映射对齐两侧滚动位置。
 *
 * 特意写成不碰 DOM 的纯函数：一是 preview.js 渲染完立刻要重建映射，二是
 * 这样才能脱离 chrome.* 环境直接单测（见 test/e2e.js 用例）。
 */
var InkPreviewSync = globalThis.InkPreviewSync || {

  /**
   * 拆分 front matter，返回它占用的行数（用于给正文的行号整体加偏移）与正文。
   * 正则需与 preview.js 里的 splitFrontMatter 保持一致——两处各自维护一份，
   * 是因为本文件要能脱离页面脚本单独加载/测试，不方便反向依赖 preview.js。
   */
  splitFrontMatter(markdown) {
    const m = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) return { frontMatterLines: 0, body: markdown };
    return { frontMatterLines: countNewlines(m[0]), body: markdown.slice(m[0].length) };
  },

  /**
   * 建立「源码行号区间 → 渲染块序号」映射。
   *
   * 原理：marked 的块级 lexer 是「逐段吃掉 src 前缀」式解析，把每个 token 的
   * `.raw` 按解析顺序拼回去必然等于原文（\r\n 会被 marked 归一成 \n，但不影响
   * 换行计数）。所以只要顺着 token 顺序累加每个 raw 里的换行数，就能精确算出
   * 每个 token 在原文里的起止行号，完全不需要自己重新解析 markdown 语法。
   *
   * @param {string} markdown 完整源码文本（textarea 里的原文，含可能的 front matter）
   * @param {(src: string) => Array<{type: string, raw: string}>} lex marked.lexer 函数
   *   （依赖注入而非直接读全局 marked：方便测试传入替身，也不锁死渲染库）
   * @returns {{ blocks: Array<{index:number,startLine:number,endLine:number,type:string}>,
   *             totalLines: number } | null}
   *   映射不可用时返回 null（空文档 / lex 不是函数 / 解析异常 / 正文不产出任何
   *   可见块），调用方此时应回退旧的比例同步，不能因此完全不同步。
   */
  buildBlockMap(markdown, lex) {
    if (typeof markdown !== 'string' || !markdown.trim() || typeof lex !== 'function') return null;
    try {
      const { frontMatterLines, body } = this.splitFrontMatter(markdown);
      const tokens = lex(body);
      if (!Array.isArray(tokens)) return null;
      const blocks = [];
      let line = frontMatterLines + 1; // 1-based 行号，从正文第一行开始
      for (const t of tokens) {
        const raw = typeof t.raw === 'string' ? t.raw : '';
        const newlines = countNewlines(raw);
        // "space"（块间空行占位）与 "def"（链接引用定义）不产出可见渲染节点，
        // 只推进行号游标，不占用块序号——保持「块序号」和「实际 DOM 子节点」一一对应。
        if (t.type !== 'space' && t.type !== 'def') {
          const startLine = line;
          const endLine = Math.max(startLine, line + newlines - (raw.endsWith('\n') ? 1 : 0));
          blocks.push({ index: blocks.length, startLine, endLine, type: t.type });
        }
        line += newlines;
      }
      if (!blocks.length) return null;
      return { blocks, totalLines: countNewlines(markdown) + 1 };
    } catch (e) {
      return null; // marked 解析异常：交给调用方回退比例同步，不向上抛
    }
  },

  /**
   * 给定一个（可以带小数的）源码行号，定位它落在哪个块里、块内进度多少（0~1）。
   * 块之间的空隙（块间空行）归属前一个块的末尾（fraction 钳到 1），文档最前面
   * 的行归属第一块的开头——这样滚动到文档首尾时不会出现「定位不到」的空档。
   *
   * @returns {{ blockIndex: number, fraction: number } | null}
   */
  locate(blocks, line) {
    if (!Array.isArray(blocks) || !blocks.length) return null;
    const target = Math.max(blocks[0].startLine, line);
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const nextStart = i + 1 < blocks.length ? blocks[i + 1].startLine : Infinity;
      if (target < nextStart || i === blocks.length - 1) {
        const span = Math.max(1, b.endLine - b.startLine);
        return { blockIndex: i, fraction: clamp01((target - b.startLine) / span) };
      }
    }
    return null; // 理论不可达，留作兜底
  },

  /** locate 的逆运算：给定块序号 + 块内进度，换算回源码行号，供反向滚动使用。 */
  unlocate(blocks, blockIndex, fraction) {
    if (!Array.isArray(blocks) || !blocks.length) return null;
    const i = Math.min(Math.max(blockIndex, 0), blocks.length - 1);
    const b = blocks[i];
    const span = Math.max(1, b.endLine - b.startLine);
    return b.startLine + clamp01(fraction) * span;
  },
};

function countNewlines(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function clamp01(v) {
  return Math.min(Math.max(v, 0), 1);
}

globalThis.InkPreviewSync = InkPreviewSync;
