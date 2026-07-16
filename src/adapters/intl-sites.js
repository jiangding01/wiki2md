/**
 * 摘墨 · 国际站点适配器
 * Stack Overflow：通用提取只能拿到问题，这里把「问题 + 全部回答」结构化导出。
 * X (Twitter)：推文详情页——主推文（含同作者 thread 续推）为正文，
 *              回复走评论通道进文末「💬 评论」区。
 */

// 幂等声明：重复注入时复用首次实例（const 重声明会抛错；裸 var 重建会清空注册表等内部状态）
var StackOverflowAdapter = window.StackOverflowAdapter || {
  id: 'stackoverflow',
  name: 'Stack Overflow',
  badge: 'precise',

  match(loc) {
    return /(\.|^)(stackoverflow\.com|serverfault\.com|superuser\.com|askubuntu\.com)$/.test(loc.hostname) &&
      /\/questions\/\d+/.test(loc.pathname);
  },

  async extract() {
    const question = document.querySelector('#question .js-post-body, .question .js-post-body');
    if (!question) return GenericAdapter.extract();

    const container = document.createElement('div');

    // 问题正文
    const qDiv = document.createElement('div');
    qDiv.appendChild(InkIR.detach(question));
    container.appendChild(qDiv);

    // 问题标签
    const tags = Array.from(document.querySelectorAll('#question .post-tag, .question .post-tag'))
      .map(t => t.textContent.trim());
    if (tags.length) {
      const p = document.createElement('p');
      p.innerHTML = '<em>标签：' + tags.map(t => `<code>${t}</code>`).join(' ') + '</em>';
      container.appendChild(p);
    }

    // 全部回答（按页面顺序，即用户选择的排序）
    document.querySelectorAll('.answer').forEach((ans) => {
      const body = ans.querySelector('.js-post-body');
      if (!body) return;
      const score = (ans.querySelector('.js-vote-count') || {}).textContent || '0';
      const accepted = ans.classList.contains('accepted-answer') ||
        !!ans.querySelector('.js-accepted-answer-indicator:not(.d-none)');
      const author = (ans.querySelector('.user-details a') || {}).textContent || '';

      const h = document.createElement('h2');
      h.textContent = `${accepted ? '✅ ' : ''}回答（${score.trim()} 票${author ? ` · ${author.trim()}` : ''}）`;
      container.appendChild(h);

      const aDiv = document.createElement('div');
      aDiv.appendChild(InkIR.detach(body));
      container.appendChild(aDiv);
    });

    InkIR.normalizeContainer(container, ['.js-post-menu', '.post-signature', 'aside']);

    return InkIR.create({
      title: InkIR.pickTitle('#question-header h1 a, #question-header h1'),
      siteName: 'Stack Overflow',
      contentEl: container,
    });
  },
};

window.StackOverflowAdapter = StackOverflowAdapter;

/* ---------------- X (Twitter) 推文详情页 ---------------- */
/**
 * 结构要点（选择器以多年稳定的 data-testid 为锚，class 是动态哈希不可用）：
 * - 每条推文：article[data-testid="tweet"]，时间线虚拟化、回复按需分页加载
 *   → 自动滚动采集，节点会被卸载所以边滚边解析成纯数据（不能存 DOM 引用）
 * - 正文 [data-testid="tweetText"]：emoji 是 <img alt="😀">，textContent 会
 *   丢 emoji，必须按 childNodes 手工拼接
 * - 主推文识别：URL /status/<id> 与卡片内 time 所在链接的 status id 对齐；
 *   其后连续同 handle 的推文是 thread 续推，并入正文
 * - 回复需登录才可见；广告卡片带 placementTracking，剔除
 */
// 幂等声明：重复注入时复用首次实例（const 重声明会抛错；裸 var 重建会清空注册表等内部状态）
var XAdapter = window.XAdapter || {
  id: 'x',
  name: 'X (Twitter)',
  badge: 'experimental', // DOM 结构随平台版本波动，真机验证后再升精配

  match(loc) {
    return /(\.|^)(x\.com|twitter\.com)$/.test(loc.hostname) &&
      /\/status\/\d+/.test(loc.pathname);
  },

  async extract(options) {
    const opts = options || {};
    const tweets = await this._harvestTweets();
    if (!tweets.length) {
      // 登录墙 / 结构变化：回退通用提取并明示，绝不空手而归
      const ir = await GenericAdapter.extract();
      ir.siteName = 'X (Twitter)';
      ir.warnings.push('未识别到推文结构（可能未登录或页面改版），已回退通用提取。');
      return ir;
    }

    const pageId = (location.pathname.match(/\/status\/(\d+)/) || [])[1] || null;
    let mainIdx = tweets.findIndex(t => t.statusId && t.statusId === pageId);
    if (mainIdx === -1) mainIdx = 0; // 找不到对齐的就取时间线首条

    const main = tweets[mainIdx];
    // thread 续推：主推文之后连续的同 handle 推文并入正文
    const thread = [main];
    for (let i = mainIdx + 1; i < tweets.length; i++) {
      if (tweets[i].handle && tweets[i].handle === main.handle) thread.push(tweets[i]);
      else break;
    }
    const replies = tweets.filter(t => !thread.includes(t) && !t.isAd);

    const container = document.createElement('div');
    for (const t of thread) this._renderTweet(t, container);
    InkIR.normalizeContainer(container);

    const warnings = [];
    if (replies.length) {
      warnings.push(`已收集当前时间线加载的 ${replies.length} 条回复；` +
        'X 按需分页加载，长对话可先手动滚动到底部再重新分析。');
    }

    const ir = InkIR.create({
      title: InkIR.pickTitle(null, /\s*[\/|]\s*X\s*$/),
      byline: [main.author, main.handle].filter(Boolean).join(' '),
      siteName: 'X (Twitter)',
      publishedTime: main.time,
      contentEl: container,
      warnings,
    });

    if (opts.includeComments !== false) {
      ir.annotations = replies.map(t => InkIR.annotation({
        kind: 'page',
        author: [t.author, t.handle].filter(Boolean).join(' '),
        time: t.time,
        content: t.text + (t.photos.length ? `（含 ${t.photos.length} 图）` : ''),
      }));
    }
    return ir;
  },

  /** 滚动采集：时间线是虚拟化的，边滚边把 tweet 解析成纯数据、按 status id 去重 */
  async _harvestTweets() {
    const byKey = new Map();
    const harvest = () => {
      document.querySelectorAll('article[data-testid="tweet"]').forEach((el) => {
        const t = this._parseTweet(el);
        const key = t.statusId || t.text.slice(0, 80);
        if (key && !byKey.has(key)) byKey.set(key, t);
      });
    };
    harvest();
    const scroller = document.scrollingElement || document.documentElement;
    const origin = scroller.scrollTop;
    let lastHeight = 0;
    for (let step = 0; step < 40; step++) {
      if (scroller.scrollHeight <= lastHeight) break; // 高度不再增长：到底或加载停止
      lastHeight = scroller.scrollHeight;
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise(r => setTimeout(r, 300)); // 等虚拟列表渲染/分页加载
      harvest();
      if (step % 5 === 4 && window.__inkProgress) {
        window.__inkProgress(`正在收集回复（已收集 ${byKey.size} 条推文）…`);
      }
    }
    scroller.scrollTop = origin;
    return Array.from(byKey.values());
  },

  /** 单条推文 → 纯数据（虚拟滚动会卸载节点，不能持有 DOM 引用） */
  _parseTweet(article) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    // 作者区：display name 与 @handle 混排在 User-Name 里
    let author = '';
    let handle = '';
    const userEl = article.querySelector('[data-testid="User-Name"]');
    if (userEl) {
      for (const s of userEl.querySelectorAll('span')) {
        const t = s.textContent.trim();
        if (!t || t === '·') continue;
        if (t.startsWith('@')) { if (!handle) handle = t; }
        else if (!author) author = t;
      }
    }
    // 卡片内 time 所在的链接指向本条推文的 status URL
    let statusId = null;
    const timeEl = article.querySelector('time[datetime]');
    const timeLink = timeEl && timeEl.closest('a[href*="/status/"]');
    if (timeLink) statusId = (timeLink.getAttribute('href').match(/\/status\/(\d+)/) || [])[1] || null;
    const photos = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img[src]'))
      .map(img => img.src.replace(/name=\w+/, 'name=large')); // 缩略图 → 大图
    return {
      statusId,
      author,
      handle,
      time: timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim()) : null,
      text: textEl ? this._tweetPlainText(textEl) : '',
      photos,
      isAd: !!article.querySelector('[data-testid="placementTracking"]'),
    };
  },

  /** tweetText → 纯文本：emoji 是 <img alt>，换行是 DOM 结构，textContent 都会丢 */
  _tweetPlainText(el) {
    let out = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) out += child.textContent;
        else if (child.nodeType !== 1) continue;
        else if (child.tagName === 'IMG') out += child.getAttribute('alt') || '';
        else if (child.tagName === 'BR') out += '\n';
        else walk(child);
      }
    };
    walk(el);
    return out.trim();
  },

  /** 推文 → 正文 DOM：文本段落 + 图片 */
  _renderTweet(t, container) {
    for (const para of t.text.split('\n')) {
      if (!para.trim()) continue;
      const p = document.createElement('p');
      p.textContent = para;
      container.appendChild(p);
    }
    for (const src of t.photos) {
      const wrap = document.createElement('p');
      const img = document.createElement('img');
      img.setAttribute('src', src);
      wrap.appendChild(img);
      container.appendChild(wrap);
    }
  },
};

window.XAdapter = XAdapter;
