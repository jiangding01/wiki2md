/**
 * 摘墨 · 中文内容平台精配适配器合集
 * 微信公众号 / 知乎 / 掘金 —— 结构稳定的 DOM 型站点，选择器 + 清洗即可精配。
 */

/* ---------------- 微信公众号 ---------------- */
// 幂等声明：重复注入时复用首次实例（const 重声明会抛错；裸 var 重建会清空注册表等内部状态）
var WechatAdapter = window.WechatAdapter || {
  id: 'wechat',
  name: '微信公众号',
  badge: 'precise',
  // 微信图床有 referer 防盗链（非登录态，但效果相同）：远程链接在本地 md
  // 里必然裂图，popup 据此建议本地打包（页面内 fetch 自带 referer，能下载）
  authImages: true,

  async extract() {
    const source = document.querySelector('#js_content');
    if (!source) return GenericAdapter.extract();

    const container = document.createElement('div');
    container.appendChild(InkIR.detach(source));
    // data-src 是原始图 URL；页面 JS 会把 src 填成 tp=webp&wx_lazy=1 的
    // 懒加载低清版——src 非空所以 fixLazyImages 不会覆盖，这里强制还原原图
    container.querySelectorAll('img[data-src]').forEach((img) => {
      img.setAttribute('src', img.getAttribute('data-src'));
    });
    this._semanticizeBoldSpans(container);
    InkIR.normalizeContainer(container, ['mpvoice', 'mp-common-profile', 'qqmusic', 'mp-style-type']);

    return InkIR.create({
      title: InkIR.pickTitle('#activity-name, h1.rich_media_title'),
      byline: InkIR.pickText('#js_name, .rich_media_meta_nickname'),
      siteName: '微信公众号',
      publishedTime: InkIR.pickText('#publish_time'),
      contentEl: container,
    });
  },

  match(loc) {
    return loc.hostname === 'mp.weixin.qq.com';
  },

  /**
   * 新版公众号编辑器的粗体不再输出 <strong>，而是 span 的 inline style：
   * 外层排版 span 常带 font-weight:bold，内层 <span textstyle> 再覆盖为
   * normal/bold——生效值由「自内向外第一个 font-weight 声明」决定。
   * 把纯样式加粗的文本叶子（span[leaf]）包上 <strong>，Turndown 才能识别。
   * （斜体在公众号编辑器里没有对应形态，暂不处理。）
   */
  _semanticizeBoldSpans(container) {
    // 生效 font-weight：自内向外第一个声明说了算（STRONG/B 视为 bold 声明）
    const effectiveBold = (start) => {
      for (let el = start; el && el !== container; el = el.parentElement) {
        if (/^(STRONG|B)$/.test(el.tagName)) return true;
        const fw = (el.style && el.style.fontWeight) || '';
        if (fw) return fw === 'bold' || fw === 'bolder' || parseInt(fw, 10) >= 600;
      }
      return false;
    };
    container.querySelectorAll('span[leaf]').forEach((sp) => {
      if (!sp.textContent.trim()) return;
      // 已有语义加粗祖先的不再处理——编辑器自产的 <strong> 内部 span 往往
      // 也带 font-weight:bold 样式，只看样式会双重包裹出嵌套 strong
      if (sp.closest('strong, b')) return;
      // 样式覆盖点在 leaf 内的 textstyle span（若有），从它开始向外找生效值
      const start = sp.querySelector('[textstyle]') || sp;
      if (!effectiveBold(start)) return;
      // strong 包在 leaf 外层：与编辑器自产的 <strong><span leaf>> 同构，
      // 相邻加粗片段才能被 mergeAdjacentEmphasis 缝合（包在内层会隔着
      // span 边界拼出 `****`）
      const strong = document.createElement('strong');
      sp.replaceWith(strong);
      strong.appendChild(sp);
    });
  },
};

/* ---------------- 知乎（专栏 & 回答） ---------------- */
// 幂等声明：重复注入时复用首次实例（const 重声明会抛错；裸 var 重建会清空注册表等内部状态）
var ZhihuAdapter = window.ZhihuAdapter || {
  id: 'zhihu',
  name: '知乎',
  badge: 'precise',

  match(loc) {
    return /(\.|^)zhihu\.com$/.test(loc.hostname) &&
      (loc.pathname.startsWith('/p/') || /\/question\/\d+\/answer\/\d+/.test(loc.pathname));
  },

  async extract() {
    const isColumn = location.pathname.startsWith('/p/');
    const source = isColumn
      ? document.querySelector('.Post-RichTextContainer .RichText, .Post-RichText')
      : document.querySelector('.QuestionAnswer-content .RichText, .AnswerCard .RichText');
    if (!source) return GenericAdapter.extract();

    const container = InkIR.buildContainer(source,
      ['.RichText-LinkCardContainer button', '.ZVideoLinkCard-triggerButton']);
    // 知乎公式图片：alt 里是 LaTeX，转成 data-ink-math 标记（转换层原样输出 $..$）
    container.querySelectorAll('img.ztext-math, img[eeimg="1"]').forEach((img) => {
      const tex = img.getAttribute('alt');
      if (tex) {
        const span = document.createElement('span');
        span.setAttribute('data-ink-math', tex);
        // 必须有文本内容：空 inline 元素会命中 Turndown 的 blank 规则被整个吞掉
        span.textContent = tex;
        img.replaceWith(span);
      }
    });

    const authorEl = document.querySelector('.AuthorInfo-name .UserLink-link, .AuthorInfo meta[itemprop="name"]');
    return InkIR.create({
      title: InkIR.pickTitle('.Post-Title, .QuestionHeader-title'),
      byline: authorEl
        ? (authorEl.getAttribute('content') || authorEl.textContent.trim())
        : null,
      siteName: '知乎',
      contentEl: container,
    });
  },
};

/* ---------------- 掘金 ---------------- */
// 幂等声明：重复注入时复用首次实例（const 重声明会抛错；裸 var 重建会清空注册表等内部状态）
var JuejinAdapter = window.JuejinAdapter || {
  id: 'juejin',
  name: '掘金',
  badge: 'precise',

  match(loc) {
    return loc.hostname === 'juejin.cn' && loc.pathname.startsWith('/post/');
  },

  async extract() {
    const source = document.querySelector('#article-root .markdown-body, .article-viewer.markdown-body');
    if (!source) return GenericAdapter.extract();

    // 掘金代码块 <pre><code class="hljs language-go"> 由转换层统一识别语言
    const container = InkIR.buildContainer(source,
      ['.copy-code-btn', '.code-block-extension-header', 'style']);

    return InkIR.create({
      title: InkIR.pickTitle('h1.article-title'),
      byline: InkIR.pickText('.author-info-block .username, .author-name .name'),
      siteName: '掘金',
      publishedTime: (document.querySelector('.meta-box time, time.time') || {}).dateTime || null,
      contentEl: container,
    });
  },
};

/* ---------------- CSDN ---------------- */
// 幂等声明：重复注入时复用首次实例（const 重声明会抛错；裸 var 重建会清空注册表等内部状态）
var CsdnAdapter = window.CsdnAdapter || {
  id: 'csdn',
  name: 'CSDN',
  badge: 'precise',

  match(loc) {
    return /(\.|^)csdn\.net$/.test(loc.hostname) && /\/article\/details\//.test(loc.pathname);
  },

  async extract() {
    const source = document.querySelector('#content_views');
    if (!source) return GenericAdapter.extract();

    const container = InkIR.buildContainer(source, [
      '.hljs-button', '.hide-preCode-box', '.look-more-preCode',
      '.dp-highlighter .bar', 'pre .toolbar',
    ]);
    // CSDN 折叠代码块：展开被隐藏的部分
    container.querySelectorAll('pre.set-code-hide').forEach(p => p.classList.remove('set-code-hide'));

    return InkIR.create({
      title: InkIR.pickTitle('h1.title-article, #articleContentId'),
      byline: InkIR.pickText('.follow-nickName, .profile-intro .user-name'),
      siteName: 'CSDN',
      publishedTime: InkIR.pickText('.bar-content .time'),
      contentEl: container,
    });
  },
};

/* ---------------- 语雀 ---------------- */
// 幂等声明：重复注入时复用首次实例（const 重声明会抛错；裸 var 重建会清空注册表等内部状态）
var YuqueAdapter = window.YuqueAdapter || {
  id: 'yuque',
  name: '语雀',
  badge: 'precise',
  authImages: true, // 语雀图床对私有文档同样需要登录态

  match(loc, doc) {
    return /(\.|^)yuque\.com$/.test(loc.hostname) &&
      !!doc.querySelector('.ne-viewer-body, .lake-content, #content .yuque-doc-content');
  },

  async extract() {
    const source = document.querySelector('.ne-viewer-body, .lake-content, #content .yuque-doc-content');
    if (!source) return GenericAdapter.extract();

    const container = InkIR.buildContainer(source,
      ['.ne-ui-hover-toolbar', '[data-testid="doc-reader-toolbar"]']);
    // 语雀标题 block：ne-h1..ne-h6 → 真实 h 标签
    for (let level = 1; level <= 6; level++) {
      container.querySelectorAll(`ne-h${level}, [data-card-type] h${level}`).forEach((el) => {
        const h = document.createElement('h' + level);
        h.innerHTML = el.innerHTML;
        el.replaceWith(h);
      });
    }

    return InkIR.create({
      title: InkIR.pickTitle('#article-title, .DocReader h1, [data-testid="doc-title"]', /\s*·\s*语雀.*$/),
      siteName: '语雀',
      contentEl: container,
    });
  },
};

window.WechatAdapter = WechatAdapter;
window.ZhihuAdapter = ZhihuAdapter;
window.JuejinAdapter = JuejinAdapter;
window.CsdnAdapter = CsdnAdapter;
window.YuqueAdapter = YuqueAdapter;
