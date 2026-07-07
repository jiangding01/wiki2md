/** 摘墨 · 设置页（通用 / Markdown 风格 / 站点规则 / 导出历史） */

const DEFAULTS = {
  frontMatter: true,
  frontMatterTags: 'clippings',
  includeTitle: true,
  includeComments: true,
  commentStyle: 'both',
  imageStrategy: 'remote',
  filenameTemplate: '{title}',
  mdBullet: '-',
  mdEmphasis: '*',
  mdFence: '```',
  mdLinkStyle: 'inlined',
  keepHistory: true,
  customRules: [],
};

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  bindTabs();

  const stored = await chrome.storage.sync.get('inkmarkSettings');
  const s = Object.assign({}, DEFAULTS, stored.inkmarkSettings || {});

  // 通用 + 风格
  for (const key of ['frontMatter', 'includeTitle', 'includeComments', 'keepHistory']) {
    $(key).checked = !!s[key];
  }
  for (const key of ['frontMatterTags', 'commentStyle', 'imageStrategy', 'filenameTemplate',
                     'mdBullet', 'mdEmphasis', 'mdFence', 'mdLinkStyle']) {
    $(key).value = s[key];
  }

  // 自定义规则
  (s.customRules || []).forEach(addRuleCard);
  $('btn-add-rule').addEventListener('click', () => addRuleCard());

  // 历史
  await renderHistory();
  $('btn-clear-history').addEventListener('click', async () => {
    await chrome.storage.local.remove('inkmarkHistory');
    await renderHistory();
  });

  // 保存
  $('btn-save').addEventListener('click', save);

  // 支持 #history 等锚点直达
  const hash = location.hash.replace('#', '');
  if (['general', 'style', 'rules', 'history'].includes(hash)) switchTab(hash);
});

/* ---------- 标签页 ---------- */

function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
}

/* ---------- 自定义规则 ---------- */

function addRuleCard(rule) {
  const r = rule || {};
  const node = $('tpl-rule').content.firstElementChild.cloneNode(true);
  node.querySelector('.r-name').value = r.name || '';
  node.querySelector('.r-match').value = r.match || '';
  node.querySelector('.r-content').value = r.contentSel || '';
  node.querySelector('.r-title').value = r.titleSel || '';
  node.querySelector('.r-remove').value = r.removeSel || '';
  node.querySelector('.rule-del').addEventListener('click', () => node.remove());
  $('rules-list').appendChild(node);
}

function collectRules() {
  return Array.from(document.querySelectorAll('.rule-card')).map((card) => ({
    name: card.querySelector('.r-name').value.trim(),
    match: card.querySelector('.r-match').value.trim(),
    contentSel: card.querySelector('.r-content').value.trim(),
    titleSel: card.querySelector('.r-title').value.trim(),
    removeSel: card.querySelector('.r-remove').value.trim(),
  })).filter(r => r.match && r.contentSel); // 必填项缺失的规则直接丢弃
}

/* ---------- 历史 ---------- */

async function renderHistory() {
  const { inkmarkHistory = [] } = await chrome.storage.local.get('inkmarkHistory');
  const list = $('history-list');
  list.innerHTML = '';

  if (!inkmarkHistory.length) {
    list.innerHTML = '<p class="history-empty">还没有导出记录。去摘一篇吧 🖋</p>';
    return;
  }

  const ACTION_LABEL = { download: '下载', zip: 'ZIP', copy: '复制', selection: '节选' };
  for (const entry of inkmarkHistory) {
    const item = document.createElement('div');
    item.className = 'history-item';

    const info = document.createElement('div');
    info.className = 'history-info';
    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = entry.title || entry.filename;
    title.title = entry.url;
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.innerHTML =
      `<span class="h-adapter">${escapeHtml(entry.adapter || '')}</span> · ` +
      `${new Date(entry.ts).toLocaleString()} · ${ACTION_LABEL[entry.action] || entry.action} · ` +
      `${(entry.chars / 1000).toFixed(1)}k 字符` +
      (entry.markdown ? '' : ' · <em>正文未保留</em>');
    info.appendChild(title);
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'history-actions';
    if (entry.markdown) {
      actions.appendChild(miniBtn('复制', async (btn) => {
        await navigator.clipboard.writeText(entry.markdown);
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '复制'; }, 1200);
      }));
      actions.appendChild(miniBtn('下载', () => {
        const blob = new Blob([entry.markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = entry.filename || 'untitled.md';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }));
    }
    actions.appendChild(miniBtn('原文', () => { window.open(entry.url, '_blank'); }));

    item.appendChild(info);
    item.appendChild(actions);
    list.appendChild(item);
  }
}

function miniBtn(text, onClick) {
  const b = document.createElement('button');
  b.className = 'btn-ghost btn-small';
  b.textContent = text;
  b.addEventListener('click', () => onClick(b));
  return b;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- 保存 ---------- */

async function save() {
  const settings = {
    frontMatter: $('frontMatter').checked,
    frontMatterTags: $('frontMatterTags').value.trim() || 'clippings',
    includeTitle: $('includeTitle').checked,
    includeComments: $('includeComments').checked,
    commentStyle: $('commentStyle').value,
    imageStrategy: $('imageStrategy').value,
    filenameTemplate: $('filenameTemplate').value.trim() || '{title}',
    mdBullet: $('mdBullet').value,
    mdEmphasis: $('mdEmphasis').value,
    mdFence: $('mdFence').value,
    mdLinkStyle: $('mdLinkStyle').value,
    keepHistory: $('keepHistory').checked,
    customRules: collectRules(),
  };
  await chrome.storage.sync.set({ inkmarkSettings: settings });
  const el = $('save-status');
  el.textContent = '已保存 ✓';
  setTimeout(() => { el.textContent = ''; }, 2000);
}
