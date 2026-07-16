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
let filenameTemplate = '{title}';
const finalizedTabs = new Set(); // 本轮已出结果（✓/✗）的 tab，见进度监听

document.addEventListener('DOMContentLoaded', async () => {
  // 图片本地化开关默认跟随全局图片策略（鉴权站点用户通常已设为 zip）
  const settings = await InkSettings.merged();
  filenameTemplate = settings.filenameTemplate || '{title}';
  $('opt-localize').checked = settings.imageStrategy === 'zip';

  // 各页面的抓图进度实时写到对应行的状态位。
  // 进度广播与导出响应走不同投递通道、顺序无保证——已定稿（✓/✗）的行
  // 不再接受迟到的进度覆盖，否则完成态会被旧进度文案冲掉
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== 'INK_PROGRESS' || !sender || !sender.tab) return;
    if (finalizedTabs.has(sender.tab.id)) return;
    const i = tabs.findIndex(t => t.id === sender.tab.id);
    if (i !== -1) setState(i, msg.text, 'busy');
  });

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
      <img class="tab-favicon">
      <span class="tab-info">
        <span class="tab-title"></span>
        <span class="tab-url"></span>
      </span>
      ${tab.discarded ? '<span class="tab-tag" title="导出时会自动唤醒并等待加载">休眠</span>' : ''}
      <span class="tab-state" id="state-${i}"></span>`;
    // 不可信字符串（标题/URL/favicon）一律走属性赋值，不进 innerHTML
    const icon = row.querySelector('.tab-favicon');
    icon.src = tab.favIconUrl || '../../assets/icons/icon16.png';
    icon.addEventListener('error', () => { icon.style.visibility = 'hidden'; });
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

/**
 * 休眠（discarded）标签页无法注入脚本——批量导出的核心人群恰恰开着
 * 几十个休眠标签页。导出前自动唤醒并等待加载完成（15s 兜底）。
 */
async function ensureAwake(tab) {
  const fresh = await chrome.tabs.get(tab.id);
  if (!fresh.discarded && fresh.status === 'complete') return;
  if (fresh.discarded) await chrome.tabs.reload(tab.id).catch(() => {});
  await new Promise((resolve) => {
    const timer = setTimeout(finish, 15000);
    function finish() {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    }
    function listener(id, info) {
      if (id === tab.id && info.status === 'complete') finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function exportSelected() {
  const picked = selectedIndexes();
  const btn = $('btn-export');
  const localize = $('opt-localize').checked;
  btn.disabled = true;
  $('opt-localize').disabled = true;
  finalizedTabs.clear();
  // 模板即时重读：批量页可能开着很久，期间用户在设置页改过文件名模板
  filenameTemplate = (await InkSettings.merged()).filenameTemplate || '{title}';

  const zip = new JSZip();
  const usedNames = new Set();
  let okCount = 0;
  let imageCount = 0;

  try {
  for (let k = 0; k < picked.length; k++) {
    const i = picked[k];
    const tab = tabs[i];
    $('batch-status').textContent = `处理中 ${k + 1}/${picked.length}…`;
    setState(i, '…', 'busy');
    try {
      await ensureAwake(tab);
      await chrome.runtime.sendMessage({ type: 'INK_INJECT', tabId: tab.id })
        .then((r) => { if (!r || !r.ok) throw new Error((r && r.error) || '注入失败'); });

      // 先分析定文件名（提取结果有缓存，导出时不会重跑）——
      // 图片要落在 assets/<md 同名目录>/，页面侧抓图前必须先知道最终唯一名，
      // 事后改名就得回头替换 md 里的引用路径
      // 显式定向顶层（frameId 0）：allFrames 广播会让子 frame 抢答/重复导出
      const ana = await chrome.tabs.sendMessage(tab.id, { type: 'INK_ANALYZE', options: {} }, { frameId: 0 });
      if (!ana || !ana.ok) throw new Error((ana && ana.error) || '分析失败');
      // 与页面侧同一实现（buildFilename）算名，规则不漂移
      const name = InkExporter
        .buildFilename(filenameTemplate, { title: ana.title, url: tab.url }, 'md')
        .replace(/\.md$/, '');
      let unique = name, n = 2;
      while (usedNames.has(unique)) unique = `${name}-${n++}`;
      usedNames.add(unique);

      const res = await chrome.tabs.sendMessage(tab.id, {
        // intent:'batch' → 与其它导出方式一致地记入导出历史
        type: 'INK_EXPORT',
        action: localize ? 'localized' : 'markdown',
        options: { intent: 'batch', assetDir: `assets/${unique}` },
      }, { frameId: 0 });
      if (!res || !res.ok) throw new Error((res && res.error) || '提取失败');

      zip.file(`${unique}.md`, res.markdown);
      const images = res.images || [];
      for (const img of images) {
        zip.file(img.path, img.base64, { base64: true });
      }
      imageCount += images.length;

      okCount += 1;
      const label = res.oversize ? '✓ 图片过大未打包（保留远程链接）'
        : res.imageFailed ? `✓ ${res.imageFailed} 张图片失败（保留远程链接）`
        : (localize && images.length ? `✓ ${images.length} 图` : '✓');
      setState(i, label, 'ok');
    } catch (e) {
      console.warn('[inkmark] batch item failed:', tab.url, e);
      setState(i, '✗ ' + shortErr(e.message), 'err');
    } finally {
      finalizedTabs.add(tab.id); // 该行已定稿，迟到的进度广播不再覆盖
    }
  }

  if (okCount > 0) {
    $('batch-status').textContent = '正在打包…';
    const blob = await zip.generateAsync({ type: 'blob' });
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    InkUI.downloadBlob(blob,
      `摘墨批量导出-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`);
  }

  $('batch-status').textContent =
    `完成：成功 ${okCount} 个` +
    (imageCount ? `、打包图片 ${imageCount} 张` : '') +
    (okCount < picked.length ? `，失败 ${picked.length - okCount} 个` : '');
  } catch (e) {
    // 打包/下载阶段的异常（如超大 ZIP 内存不足）：明示失败，
    // 控件恢复交给 finally——此前这里无保护，按钮会被永久禁用
    console.warn('[inkmark] batch export failed:', e);
    $('batch-status').textContent = '导出失败：' + shortErr(e.message);
  } finally {
    btn.disabled = false;
    $('opt-localize').disabled = false;
  }
}

function shortErr(msg) {
  const m = String(msg || '');
  if (/Receiving end|Could not establish/i.test(m)) return '页面不支持';
  if (/Cannot access|cannot be scripted/i.test(m)) return '无法访问';
  return m.slice(0, 20);
}
