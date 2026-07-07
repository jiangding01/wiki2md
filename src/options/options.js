/** 摘墨 · 设置页 */

const DEFAULTS = {
  frontMatter: true,
  includeTitle: true,
  includeComments: true,
  commentStyle: 'both',
  imageStrategy: 'remote',
  filenameTemplate: '{title}',
};

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.sync.get('inkmarkSettings');
  const s = Object.assign({}, DEFAULTS, stored.inkmarkSettings || {});

  document.getElementById('frontMatter').checked = s.frontMatter;
  document.getElementById('includeTitle').checked = s.includeTitle;
  document.getElementById('includeComments').checked = s.includeComments;
  document.getElementById('commentStyle').value = s.commentStyle;
  document.getElementById('imageStrategy').value = s.imageStrategy;
  document.getElementById('filenameTemplate').value = s.filenameTemplate;

  document.getElementById('btn-save').addEventListener('click', async () => {
    const settings = {
      frontMatter: document.getElementById('frontMatter').checked,
      includeTitle: document.getElementById('includeTitle').checked,
      includeComments: document.getElementById('includeComments').checked,
      commentStyle: document.getElementById('commentStyle').value,
      imageStrategy: document.getElementById('imageStrategy').value,
      filenameTemplate: document.getElementById('filenameTemplate').value.trim() || '{title}',
    };
    await chrome.storage.sync.set({ inkmarkSettings: settings });
    const el = document.getElementById('save-status');
    el.textContent = '已保存 ✓';
    setTimeout(() => { el.textContent = ''; }, 2000);
  });
});
