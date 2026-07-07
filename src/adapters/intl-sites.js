/**
 * 摘墨 · 国际站点适配器
 * Stack Overflow：通用提取只能拿到问题，这里把「问题 + 全部回答」结构化导出。
 */

const StackOverflowAdapter = {
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

    InkIR.removeNoise(container, ['.js-post-menu', '.post-signature', 'aside']);
    InkIR.fixLazyImages(container);
    InkIR.absolutizeUrls(container);

    const titleEl = document.querySelector('#question-header h1 a, #question-header h1');
    return InkIR.create({
      title: titleEl ? titleEl.textContent.trim() : document.title,
      siteName: 'Stack Overflow',
      contentEl: container,
    });
  },
};

window.StackOverflowAdapter = StackOverflowAdapter;
