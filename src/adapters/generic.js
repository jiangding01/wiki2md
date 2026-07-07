/**
 * 摘墨 · 通用适配器（兜底）
 *
 * Readability 抽正文 + 懒加载修复 + URL 绝对化。
 * 任何没有专门适配的网页都由它处理——「支持所有网页」的基石。
 */

const GenericAdapter = {
  id: 'generic',
  name: '通用模式',
  badge: 'generic',

  match() {
    return true; // 永远兜底
  },

  async extract() {
    // Readability 会改写传入的文档，必须用克隆
    const docClone = document.cloneNode(true);
    InkIR.fixLazyImages(docClone);

    let article = null;
    try {
      article = new Readability(docClone, {
        keepClasses: true, // 保留 class：代码块语言 (language-*) 靠它识别
        charThreshold: 200,
      }).parse();
    } catch (e) {
      console.warn('[inkmark] readability failed:', e);
    }

    const container = document.createElement('div');
    const warnings = [];

    if (article && article.content) {
      container.innerHTML = article.content;
    } else {
      // Readability 判定失败（弱结构页面）：退化为 <body> 全量 + 强清洗
      warnings.push('未能识别出明确的正文区域，已导出整页内容，可能包含噪音。');
      container.innerHTML = document.body.innerHTML;
      InkIR.removeNoise(container, [
        'nav', 'header', 'footer', 'aside', 'form',
        '[class*="sidebar"]', '[class*="comment-form"]', '[id*="cookie"]',
      ]);
    }

    InkIR.removeNoise(container);
    InkIR.fixLazyImages(container);
    InkIR.absolutizeUrls(container);

    return InkIR.create({
      title: (article && article.title) || document.title,
      byline: (article && article.byline) || this._metaAuthor(),
      siteName: (article && article.siteName) || this._metaSite(),
      excerpt: article && article.excerpt,
      publishedTime: (article && article.publishedTime) || this._metaTime(),
      contentEl: container,
      warnings,
    });
  },

  _metaAuthor() {
    const m = document.querySelector('meta[name="author"], meta[property="article:author"]');
    return m ? m.getAttribute('content') : null;
  },
  _metaSite() {
    const m = document.querySelector('meta[property="og:site_name"]');
    return m ? m.getAttribute('content') : null;
  },
  _metaTime() {
    const m = document.querySelector('meta[property="article:published_time"], meta[name="date"]');
    return m ? m.getAttribute('content') : null;
  },
};

// 注意：Generic 必须最后注册（见 pipeline.js 的注册顺序）
window.GenericAdapter = GenericAdapter;
