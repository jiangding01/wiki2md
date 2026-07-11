/**
 * 摘墨 · 跨 frame 正文选优（纯函数）
 *
 * 部分页面（邮箱、在线预览器）把正文放在 iframe 里，顶层 frame 几乎为空。
 * popup 向每个 frame 定向发 INK_ANALYZE 收集摘要后，用本模块选出「正文所在 frame」。
 *
 * 设计原则：顶层优先。绝大多数网页正文就在顶层，只有当顶层贫瘠
 * 且某子 frame 显著更优（精配适配器命中 或 字数远超顶层）时才切换——
 * 避免被广告/评论 iframe 里的零星文字误导。
 *
 * 运行环境：popup（有 window）与测试（页面上下文）。用 globalThis 兼容 SW。
 *
 * frame 摘要形态（由 popup 从各 frame 的 INK_ANALYZE 结果整理）：
 *   { frameId: number, isTop: boolean, ok: boolean,
 *     adapterId: string, badge: string, words: number }
 */

var InkFrameSelect = globalThis.InkFrameSelect || {

  /** 选优阈值——集中一处，便于测试与调参 */
  THRESHOLDS: {
    topRich: 200,   // 顶层字数 ≥ 此值即视为「正文在顶层」，直接采用，不看子 frame
    childMin: 100,  // 子 frame 字数 ≥ 此值才够格作为正文候选（滤掉广告/工具条 iframe）
    dominance: 3,   // 子 frame 字数 ≥ 顶层的此倍数，才算「字数远超」而值得切换
  },

  /**
   * 从各 frame 的分析摘要里选出正文所在 frame。
   * @param {Array} frames 各 frame 摘要（见文件头形态说明）
   * @param {Object} [opts] 覆盖 THRESHOLDS 的部分字段（测试用）
   * @returns {{ frameId, isTop, reason }} 选中帧与理由
   *   reason: top-rich | top-only | top-kept | top-fallback | all-empty
   *         | child-precise | child-dominant | child-top-failed
   */
  pickContentFrame(frames, opts) {
    const cfg = Object.assign({}, this.THRESHOLDS, opts);
    const list = Array.isArray(frames) ? frames : [];
    // 顶层帧：优先按 isTop 标记，退而按 frameId===0（Chrome 主框架恒为 0），再退到首个
    const top = list.find((f) => f && f.isTop) ||
                list.find((f) => f && f.frameId === 0) ||
                list[0] || null;
    const topReturn = (reason) => ({
      frameId: top ? top.frameId : 0, isTop: true, reason,
    });

    const isPrecise = (f) => !!(f && f.ok && f.adapterId && f.adapterId !== 'generic');
    const wordsOf = (f) => (f && f.ok && f.words) || 0;

    const topOk = !!(top && top.ok);
    const topWords = wordsOf(top);

    // 顶层内容充分：直接采用（绝大多数页面走这里，不受子 frame 干扰）
    if (topOk && topWords >= cfg.topRich) return topReturn('top-rich');

    // 顶层贫瘠——挑选最优子 frame 候选。
    // 顶层完全失败时放宽门槛：任何有正文的子 frame 都优于空顶层。
    const minChild = topOk ? cfg.childMin : 1;
    const children = list.filter((f) =>
      f && f !== top && f.ok && wordsOf(f) >= minChild);

    if (!children.length) {
      if (!topOk) return topReturn('all-empty'); // 顶层与子 frame 均无内容
      return topReturn('top-only');
    }

    // 候选排序：精配命中优先（大权重），同级再比字数
    const score = (f) => (isPrecise(f) ? 1e7 : 0) + wordsOf(f);
    const best = children.slice().sort((a, b) => score(b) - score(a))[0];
    const pickBest = (reason) => ({
      frameId: best.frameId, isTop: false, reason,
    });

    // 顶层彻底失败：直接用最优子 frame
    if (!topOk) return pickBest('child-top-failed');

    // 顶层贫瘠但可用——只有子 frame「显著更优」才切换
    if (isPrecise(best)) return pickBest('child-precise');
    if (wordsOf(best) >= Math.max(cfg.topRich, topWords * cfg.dominance)) {
      return pickBest('child-dominant');
    }
    // 子 frame 不够显著优 → 保持顶层
    return topReturn('top-kept');
  },
};

globalThis.InkFrameSelect = InkFrameSelect;
