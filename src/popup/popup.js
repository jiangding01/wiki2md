/**
 * 摘墨 · Popup 控制器
 * 打开即分析当前页 → 展示适配器/统计 → 按用户选项驱动导出。
 */

const $ = (id) => document.getElementById(id);

const state = {
  tabId: null,
  imageStrategy: 'remote',
  settings: {},
  analyzing: false,
};

const IS_EXTENSION = typeof chrome !== 'undefined' && !!(chrome.tabs && chrome.runtime && chrome.runtime.id);

/* ---------- 初始化 ---------- */

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  if (!IS_EXTENSION) return demoMode(); // 独立打开 html 时展示设计稿数据

  state.settings = await loadSettings();
  applySettingsToUI();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || /^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
    return showError('无法在此页面使用', '系统页面（chrome:// 等）无法导出');
  }
  state.tabId = tab.id;

  // 内容脚本进度实时回显（图片抓取 / 飞书滚动采集）。
  // 分析阶段界面停在加载态，进度必须写到加载文案上，否则用户以为卡死了。
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'INK_PROGRESS') {
      if (!$('state-loading').classList.contains('hidden')) {
        $('loading-text').textContent = msg.text;
      } else {
        const el = $('status-line');
        el.textContent = msg.text;
        el.classList.remove('err');
      }
    }
  });

  try {
    const inject = await chrome.runtime.sendMessage({ type: 'INK_INJECT', tabId: tab.id });
    if (!inject || !inject.ok) throw new Error((inject && inject.error) || '脚本注入失败');
    await analyze();
  } catch (e) {
    if ((tab.url || '').startsWith('file:')) {
      showError('无法访问本地文件页面',
        '请在 chrome://extensions → 摘墨 → 详情 中开启「允许访问文件网址」后重试');
    } else {
      showError('页面分析失败', friendlyError(e.message));
    }
  }
});

/** popup 里的选择即时写回默认设置——用户的偏好应当被记住 */
async function persistPrefs(partial) {
  if (!IS_EXTENSION) return;
  try {
    const { inkmarkSettings = {} } = await chrome.storage.sync.get('inkmarkSettings');
    await chrome.storage.sync.set({ inkmarkSettings: Object.assign({}, inkmarkSettings, partial) });
  } catch (e) { /* 持久化失败不影响本次导出 */ }
}

/** 向页面发消息，注入尚未就绪时自动重试一次 */
async function sendToPage(payload) {
  try {
    return await chrome.tabs.sendMessage(state.tabId, payload);
  } catch (e) {
    if (/Receiving end does not exist/i.test(e.message || '')) {
      await chrome.runtime.sendMessage({ type: 'INK_INJECT', tabId: state.tabId });
      await new Promise(r => setTimeout(r, 250));
      return chrome.tabs.sendMessage(state.tabId, payload);
    }
    throw e;
  }
}

/** 把 Chrome 的原始报错翻译成用户能行动的话 */
function friendlyError(msg) {
  const m = String(msg || '');
  if (/Receiving end does not exist|Could not establish connection/i.test(m)) {
    return '页面尚未就绪，请刷新页面后重试';
  }
  if (/Cannot access contents|cannot be scripted|The extensions gallery/i.test(m)) {
    return '浏览器限制：此页面不允许扩展访问（应用商店、系统页面等）';
  }
  if (/No tab with id/i.test(m)) {
    return '标签页已关闭';
  }
  return m || '未知错误';
}

async function analyze() {
  state.analyzing = true;
  $('state-ready').classList.add('hidden');
  $('state-error').classList.add('hidden');
  $('state-loading').classList.remove('hidden');
  $('loading-text').textContent = '正在研墨，分析页面…';
  let res = null;
  try {
    res = await sendToPage({
      type: 'INK_ANALYZE',
      options: { includeComments: $('opt-comments').checked },
    });
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  state.analyzing = false;
  if (!res || !res.ok) {
    return showError('页面分析失败', friendlyError(res && res.error));
  }
  renderAnalysis(res);
}

/* ---------- 渲染 ---------- */

function renderAnalysis(res) {
  $('state-loading').classList.add('hidden');
  $('state-error').classList.add('hidden');
  $('state-ready').classList.remove('hidden');

  const badge = $('adapter-badge');
  badge.textContent = res.adapter.name + (res.adapter.badge === 'experimental' ? ' · 实验性' : '');
  badge.className = 'badge ' + res.adapter.badge;

  // 站点名与适配器名相同则不重复展示
  $('doc-site').textContent = (res.siteName && res.siteName !== res.adapter.name) ? res.siteName : '';

  $('doc-title').value = res.title || '';
  $('stat-words').textContent = formatNum(res.stats.words);
  $('stat-images').textContent = res.stats.images;
  $('stat-tables').textContent = res.stats.tables;
  $('stat-code').textContent = res.stats.codeBlocks;

  if (res.stats.comments > 0) {
    $('stat-comments-wrap').classList.remove('hidden');
    $('stat-comments').textContent = res.stats.comments;
  } else {
    $('stat-comments-wrap').classList.add('hidden');
  }

  const w = $('warnings');
  if (res.warnings && res.warnings.length) {
    w.classList.remove('hidden');
    w.textContent = res.warnings.join(' ');
  } else {
    w.classList.add('hidden');
  }
}

function showError(msg, hint) {
  $('state-loading').classList.add('hidden');
  $('state-ready').classList.add('hidden');
  $('state-error').classList.remove('hidden');
  $('error-message').textContent = msg;
  if (hint) document.querySelector('.error-hint').textContent = hint;
}

function formatNum(n) {
  return n >= 10000 ? (n / 10000).toFixed(1) + 'w' : String(n);
}

function status(msg, isError) {
  const el = $('status-line');
  el.textContent = msg;
  el.classList.toggle('err', !!isError);
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
}

/* ---------- 导出动作 ---------- */

/**
 * 只传 popup 明确控制的字段。其余设置由 pipeline 从 storage 实时读取——
 * 若把打开时的设置快照整包传过去，用户中途在设置页做的修改会被旧快照覆盖。
 */
function exportOptions() {
  return {
    frontMatter: $('opt-frontmatter').checked,
    includeComments: $('opt-comments').checked,
    title: $('doc-title').value,
  };
}

async function doDownload() {
  const btn = $('btn-download');
  btn.disabled = true;
  try {
    if (state.imageStrategy === 'zip') {
      $('btn-download-label').textContent = '抓取图片中…';
      const res = await sendToPage({ type: 'INK_EXPORT', action: 'zip', options: exportOptions() });
      if (!res.ok) throw new Error(res.error);
      status(`已打包 ${res.imageCount} 张图片` + (res.failedCount ? `（${res.failedCount} 张失败，保留远程链接）` : ''));
    } else {
      const res = await sendToPage({ type: 'INK_EXPORT', action: 'download', options: exportOptions() });
      if (!res.ok) throw new Error(res.error);
      status('已下载 ' + res.filename);
    }
  } catch (e) {
    status('导出失败：' + e.message, true);
  } finally {
    btn.disabled = false;
    $('btn-download-label').textContent = state.imageStrategy === 'zip' ? '下载 ZIP（含图片）' : '下载 Markdown';
  }
}

async function doCopy() {
  try {
    const res = await sendToPage({
      type: 'INK_EXPORT', action: 'markdown',
      options: Object.assign(exportOptions(), { intent: 'copy' }),
    });
    if (!res.ok) throw new Error(res.error);
    await navigator.clipboard.writeText(res.markdown);
    status('已复制到剪贴板');
  } catch (e) {
    status('复制失败：' + e.message, true);
  }
}

async function doPreview() {
  try {
    const res = await sendToPage({
      type: 'INK_EXPORT', action: 'markdown', options: exportOptions(),
    });
    if (!res.ok) throw new Error(res.error);
    await chrome.storage.local.set({
      inkmarkPreview: { markdown: res.markdown, title: res.title, filename: res.filename, ts: Date.now() },
    });
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/preview/preview.html') });
    window.close();
  } catch (e) {
    status('预览失败：' + e.message, true);
  }
}

/* ---------- 事件 ---------- */

function bindEvents() {
  $('btn-download').addEventListener('click', doDownload);
  $('btn-copy').addEventListener('click', doCopy);
  $('btn-preview').addEventListener('click', doPreview);
  $('btn-settings').addEventListener('click', () => {
    if (IS_EXTENSION) chrome.runtime.openOptionsPage();
  });
  $('btn-reanalyze').addEventListener('click', (e) => {
    e.preventDefault();
    if (IS_EXTENSION && state.tabId && !state.analyzing) analyze();
  });
  $('link-batch').addEventListener('click', () => {
    if (IS_EXTENSION) chrome.tabs.create({ url: chrome.runtime.getURL('src/batch/batch.html') });
  });
  $('link-history').addEventListener('click', () => {
    if (IS_EXTENSION) chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#history') });
  });

  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.imageStrategy = btn.dataset.value;
      $('btn-download-label').textContent =
        state.imageStrategy === 'zip' ? '下载 ZIP（含图片）' : '下载 Markdown';
      persistPrefs({ imageStrategy: state.imageStrategy });
    });
  });

  $('opt-frontmatter').addEventListener('change', () => {
    persistPrefs({ frontMatter: $('opt-frontmatter').checked });
  });

  // 切换「导出评论」需要重新分析（评论是异步拉取的）
  $('opt-comments').addEventListener('change', () => {
    persistPrefs({ includeComments: $('opt-comments').checked });
    if (IS_EXTENSION && state.tabId && !state.analyzing) analyze();
  });
}

/* ---------- 设置 ---------- */

async function loadSettings() {
  const defaults = {
    frontMatter: true, includeComments: true, commentStyle: 'both',
    imageStrategy: 'remote', filenameTemplate: '{title}', includeTitle: true,
  };
  const stored = await chrome.storage.sync.get('inkmarkSettings');
  return Object.assign(defaults, stored.inkmarkSettings || {});
}

function applySettingsToUI() {
  $('opt-frontmatter').checked = !!state.settings.frontMatter;
  $('opt-comments').checked = !!state.settings.includeComments;
  state.imageStrategy = state.settings.imageStrategy || 'remote';
  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.value === state.imageStrategy);
  });
  $('btn-download-label').textContent =
    state.imageStrategy === 'zip' ? '下载 ZIP（含图片）' : '下载 Markdown';
}

/* ---------- 设计稿演示模式（file:// 直接打开时） ---------- */

function demoMode() {
  renderAnalysis({
    ok: true,
    adapter: { id: 'confluence', name: 'Confluence', badge: 'precise' },
    title: '支付网关重构 · 技术方案评审',
    siteName: 'Confluence',
    stats: { words: 4260, images: 12, tables: 3, codeBlocks: 8, comments: 17 },
    warnings: [],
  });
}
