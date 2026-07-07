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

  match(loc) {
    return loc.hostname === 'mp.weixin.qq.com';
  },

  async extract() {
    const source = document.querySelector('#js_content');
    if (!source) return GenericAdapter.extract();

    const container = document.createElement('div');
    container.appendChild(InkIR.detach(source));

    InkIR.fixLazyImages(container); // 公众号图片全是 data-src 懒加载
    InkIR.removeNoise(container, ['mpvoice', 'mp-common-profile', 'qqmusic']);
    InkIR.absolutizeUrls(container);

    const titleEl = document.querySelector('#activity-name, h1.rich_media_title');
    const authorEl = document.querySelector('#js_name, .rich_media_meta_nickname');

    return InkIR.create({
      title: titleEl ? titleEl.textContent.trim() : document.title,
      byline: authorEl ? authorEl.textContent.trim() : null,
      siteName: '微信公众号',
      publishedTime: (document.querySelector('#publish_time') || {}).textContent || null,
      contentEl: container,
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

    const container = document.createElement('div');
    container.appendChild(InkIR.detach(source));
    InkIR.fixLazyImages(container);
    InkIR.removeNoise(container, ['.RichText-LinkCardContainer button', '.ZVideoLinkCard-triggerButton']);
    // 知乎公式图片：alt 里是 LaTeX，转成 data-ink-math 标记（转换层原样输出 $..$）
    container.querySelectorAll('img.ztext-math, img[eeimg="1"]').forEach((img) => {
      const tex = img.getAttribute('alt');
      if (tex) {
        const span = document.createElement('span');
        span.setAttribute('data-ink-math', tex);
        img.replaceWith(span);
      }
    });
    InkIR.absolutizeUrls(container);

    const titleEl = document.querySelector('.Post-Title, .QuestionHeader-title');
    const authorEl = document.querySelector('.AuthorInfo-name .UserLink-link, .AuthorInfo meta[itemprop="name"]');

    return InkIR.create({
      title: titleEl ? titleEl.textContent.trim() : document.title,
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

    const container = document.createElement('div');
    container.appendChild(InkIR.detach(source));
    InkIR.fixLazyImages(container);
    InkIR.removeNoise(container, ['.copy-code-btn', '.code-block-extension-header', 'style']);
    // 掘金代码块：<pre><code class="hljs language-go">
    InkIR.absolutizeUrls(container);

    const titleEl = document.querySelector('h1.article-title');
    const authorEl = document.querySelector('.author-info-block .username, .author-name .name');

    return InkIR.create({
      title: titleEl ? titleEl.textContent.trim() : document.title,
      byline: authorEl ? authorEl.textContent.trim() : null,
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

    const container = document.createElement('div');
    container.appendChild(InkIR.detach(source));
    InkIR.fixLazyImages(container);
    InkIR.removeNoise(container, [
      '.hljs-button', '.hide-preCode-box', '.look-more-preCode',
      '.dp-highlighter .bar', 'pre .toolbar',
    ]);
    // CSDN 折叠代码块：展开被隐藏的部分
    container.querySelectorAll('pre.set-code-hide').forEach(p => p.classList.remove('set-code-hide'));
    InkIR.absolutizeUrls(container);

    const titleEl = document.querySelector('h1.title-article, #articleContentId');
    const authorEl = document.querySelector('.follow-nickName, .profile-intro .user-name');

    return InkIR.create({
      title: titleEl ? titleEl.textContent.trim() : document.title,
      byline: authorEl ? authorEl.textContent.trim() : null,
      siteName: 'CSDN',
      publishedTime: (document.querySelector('.bar-content .time') || {}).textContent || null,
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

    const container = document.createElement('div');
    container.appendChild(InkIR.detach(source));
    InkIR.fixLazyImages(container);
    InkIR.removeNoise(container, ['.ne-ui-hover-toolbar', '[data-testid="doc-reader-toolbar"]']);
    // 语雀标题 block：ne-h1..ne-h6 → 真实 h 标签
    for (let level = 1; level <= 6; level++) {
      container.querySelectorAll(`ne-h${level}, [data-card-type] h${level}`).forEach((el) => {
        const h = document.createElement('h' + level);
        h.innerHTML = el.innerHTML;
        el.replaceWith(h);
      });
    }
    InkIR.absolutizeUrls(container);

    const titleEl = document.querySelector('#article-title, .DocReader h1, [data-testid="doc-title"]');
    return InkIR.create({
      title: titleEl ? titleEl.textContent.trim() : document.title.replace(/\s*·\s*语雀.*$/, '').trim(),
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
