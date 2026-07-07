/**
 * 摘墨 · 中文内容平台精配适配器合集
 * 微信公众号 / 知乎 / 掘金 —— 结构稳定的 DOM 型站点，选择器 + 清洗即可精配。
 */

/* ---------------- 微信公众号 ---------------- */
const WechatAdapter = {
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
const ZhihuAdapter = {
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
    // 知乎公式图片：alt 里是 LaTeX，转成 $..$
    container.querySelectorAll('img.ztext-math, img[eeimg="1"]').forEach((img) => {
      const tex = img.getAttribute('alt');
      if (tex) img.replaceWith(document.createTextNode(`$${tex}$`));
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
const JuejinAdapter = {
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

window.WechatAdapter = WechatAdapter;
window.ZhihuAdapter = ZhihuAdapter;
window.JuejinAdapter = JuejinAdapter;
