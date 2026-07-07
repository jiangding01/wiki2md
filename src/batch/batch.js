/**
 * 摘墨 · 批量导出
 *
 * 流程：按需申请 tabs + <all_urls> 权限 → 列出当前窗口标签页 →
 * 逐个注入管线、取回 Markdown → 打包为单个 ZIP 下载。
 * 单页失败不影响整批（状态逐行展示）。
 */

const PERMS = { permissions: ['tabs'], origins: ['<all_urls>'] };
const $ = (id) => document.getElementById(id);

let tabs = [];

document.addEventListener('DOMContentLoaded', async () => {
  const granted = await chrome.permissions.contains(PERMS);
  if (granted) {
    await showPicker();
  } else {
    $('perm-gate').classList.remove('hidden');
    $('btn-grant').addEventListener('click', async () => {
      const ok = await chrome.permissions.request(PERMS);
      if (ok) {
        $('perm-gate').classList.add('hidden');
        await showPicker();
      } else {
        $('perm-denied').classList.remove('hidden');
      }
    });
  }
});

async function showPicker() {
  $('tab-picker').classList.remove('hidden');
  const all = await chrome.tabs.query({ currentWindow: true });
  tabs = all.filter(t => /^https?:/.test(t.url || ''));

  const list = $('tab-list');
  list.innerHTML = '';
  tabs.forEach((tab, i) => {
    const row = document.createElement('label');
    row.className = 'tab-item';
    row.innerHTML = `
      <input type="checkbox" data-i="${i}" checked>
      <img class="tab-favicon" src="${tab.favIconUrl || '../../assets/icons/icon16.png'}"
           onerror="this.style.visibility='hidden'">
      <span class="tab-info">
        <span class="tab-title"></span>
        <span class="tab-url"></span>
      </span>
      <span class="tab-state" id="state-${i}"></span>`;
    row.querySelector('.tab-title').textContent = tab.title || '(无标题)';
    row.querySelector('.tab-url').textContent = tab.url;
    list.appendChild(row);
  });
  updateCount();

  $('check-all').addEventListener('change', (e) => {
    list.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = e.target.checked; });
    updateCount();
  });
  list.addEventListener('change', updateCount);
  $('btn-export').addEventListener('click', exportSelected);
}

function updateCount() {
  const n = selectedIndexes().length;
  $('tab-count').textContent = `已选 ${n} / ${tabs.length} 个页面`;
  $('btn-export').disabled = n === 0;
}

function selectedIndexes() {
  return Array.from(document.querySelectorAll('#tab-list input:checked'))
    .map(cb => Number(cb.dataset.i));
}

function setState(i, text, cls) {
  const el = $(`state-${i}`);
  el.textContent = text;
  el.className = 'tab-state ' + (cls || '');
}

async function exportSelected() {
  const picked = selectedIndexes();
  const btn = $('btn-export');
  btn.disabled = true;

  const zip = new JSZip();
  const usedNames = new Set();
  let okCount = 0;

  for (let k = 0; k < picked.length; k++) {
    const i = picked[k];
    const tab = tabs[i];
    $('batch-status').textContent = `处理中 ${k + 1}/${picked.length}…`;
    setState(i, '…', 'busy');
    try {
      await chrome.runtime.sendMessage({ type: 'INK_INJECT', tabId: tab.id })
        .then((r) => { if (!r || !r.ok) throw new Error((r && r.error) || '注入失败'); });
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: 'INK_EXPORT', action: 'markdown', options: {},
      });
      if (!res || !res.ok) throw new Error((res && res.error) || '提取失败');

      let name = (res.filename || 'untitled.md').replace(/\.md$/, '');
      let unique = name, n = 2;
      while (usedNames.has(unique)) unique = `${name}-${n++}`;
      usedNames.add(unique);
      zip.file(`${unique}.md`, res.markdown);

      okCount += 1;
      setState(i, '✓', 'ok');
    } catch (e) {
      console.warn('[inkmark] batch item failed:', tab.url, e);
      setState(i, '✗ ' + shortErr(e.message), 'err');
    }
  }

  if (okCount > 0) {
    $('batch-status').textContent = '正在打包…';
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    a.download = `摘墨批量导出-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  $('batch-status').textContent =
    `完成：成功 ${okCount} 个` + (okCount < picked.length ? `，失败 ${picked.length - okCount} 个` : '');
  btn.disabled = false;
}

function shortErr(msg) {
  const m = String(msg || '');
  if (/Receiving end|Could not establish/i.test(m)) return '页面不支持';
  if (/Cannot access|cannot be scripted/i.test(m)) return '无法访问';
  return m.slice(0, 20);
}
