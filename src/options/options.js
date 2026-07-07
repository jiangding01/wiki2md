/** 摘墨 · 设置页（通用 / Markdown 风格 / 站点规则 / 导出历史） */

// 默认值与存储读写的唯一实现在 core/settings.js（本页 html 已引入）
const DEFAULTS = InkSettings.DEFAULTS;
const readSettings = () => InkSettings.read();
const writeSettings = (s) => InkSettings.write(s);

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  bindTabs();

  const s = Object.assign({}, DEFAULTS, await readSettings());

  // 通用 + 风格
  for (const key of ['frontMatter', 'includeTitle', 'includeComments', 'highlightAnchors', 'keepHistory']) {
    $(key).checked = !!s[key];
  }
  for (const key of ['frontMatterTags', 'commentStyle', 'imageStrategy', 'filenameTemplate',
                     'mdBullet', 'mdEmphasis', 'mdFence', 'mdLinkStyle', 'complexTable']) {
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

  // 配置备份 / 迁移 / 团队共享自定义规则
  $('btn-export-cfg').addEventListener('click', exportConfig);
  $('btn-import-cfg').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', importConfig);
  $('btn-reset-cfg').addEventListener('click', async () => {
    if (!confirm('确定恢复全部默认设置？自定义站点规则也会被清除（导出历史不受影响）。')) return;
    await InkSettings.reset();
    location.reload();
  });

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
  // 用户开始补填时立刻撤掉红色警示
  node.addEventListener('input', () => node.classList.remove('invalid'));
  $('rules-list').appendChild(node);
}

/**
 * 收集规则并校验。半填的规则绝不静默丢弃——高亮标出、保留在界面上，
 * 并通过返回值告知调用方给出提示。完全空白的卡片视为用户放弃，忽略。
 */
function collectRules() {
  const valid = [];
  let invalidCount = 0;
  document.querySelectorAll('.rule-card').forEach((card) => {
    const rule = {
      name: card.querySelector('.r-name').value.trim(),
      match: card.querySelector('.r-match').value.trim(),
      contentSel: card.querySelector('.r-content').value.trim(),
      titleSel: card.querySelector('.r-title').value.trim(),
      removeSel: card.querySelector('.r-remove').value.trim(),
    };
    const filledAny = Object.values(rule).some(Boolean);
    const complete = rule.match && rule.contentSel;
    card.classList.toggle('invalid', filledAny && !complete);
    if (complete) {
      valid.push(rule);
    } else if (filledAny) {
      invalidCount += 1;
    }
  });
  return { valid, invalidCount };
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

  const ACTION_LABEL = { download: '下载', zip: 'ZIP', copy: '复制', selection: '节选', batch: '批量' };
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

/* ---------- 配置导入 / 导出 ---------- */

async function exportConfig() {
  const payload = {
    app: 'inkmark',
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    settings: Object.assign({}, DEFAULTS, await readSettings()),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'inkmark-settings.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function importConfig(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // 允许重复选择同一文件
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = parsed.settings || parsed; // 兼容裸设置对象
    if (typeof incoming !== 'object' || incoming === null) throw new Error('格式不正确');
    // 只接受已知字段，未知字段丢弃——导入的文件不可信
    const clean = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (key === 'customRules') continue; // 数组字段单独校验
      if (key in incoming && typeof incoming[key] === typeof DEFAULTS[key]) {
        clean[key] = incoming[key];
      }
    }
    if (Array.isArray(incoming.customRules)) {
      clean.customRules = incoming.customRules
        .filter(r => r && typeof r.match === 'string' && typeof r.contentSel === 'string')
        .map(r => ({
          name: String(r.name || ''), match: r.match, contentSel: r.contentSel,
          titleSel: String(r.titleSel || ''), removeSel: String(r.removeSel || ''),
        }));
    }
    await writeSettings(Object.assign({}, DEFAULTS, clean));
    location.reload();
  } catch (err) {
    const el = $('save-status');
    el.textContent = '导入失败：' + (err.message || '文件格式不正确');
    setTimeout(() => { el.textContent = ''; }, 4000);
  }
}

/* ---------- 保存 ---------- */

async function save() {
  const rules = collectRules();
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
    complexTable: $('complexTable').value,
    highlightAnchors: $('highlightAnchors').checked,
    keepHistory: $('keepHistory').checked,
    customRules: rules.valid,
  };
  await writeSettings(settings);
  const el = $('save-status');
  if (rules.invalidCount > 0) {
    el.textContent = `已保存，但有 ${rules.invalidCount} 条规则缺少必填项（URL 包含 / 正文选择器）未生效`;
    switchTab('rules');
    setTimeout(() => { el.textContent = ''; }, 6000);
  } else {
    el.textContent = '已保存 ✓';
    setTimeout(() => { el.textContent = ''; }, 2000);
  }
}
