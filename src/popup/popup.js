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
  busy: false, // 任一导出进行中：全部动作与选项互斥
  localAction: false, // 本 popup 发起的动作进行中（区分页面侧忙态广播的来源）
  autoSwitchedZip: false, // 鉴权站点自动切 zip 只做一次，用户手动切回后不再强制
};

/**
 * 导出互斥：任一导出（下载/ZIP/页面树/复制/预览）进行中，
 * 其余动作按钮与选项全部禁用——并发导出不会损坏数据
 * （提取层有去重），但会双倍抓图、进度互相覆盖、弹出多个下载。
 */
function setBusy(busy) {
  state.busy = busy;
  ['btn-download', 'btn-tree', 'btn-copy', 'btn-preview',
   'opt-frontmatter', 'opt-comments', 'btn-reanalyze', 'doc-title'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = busy;
  });
  document.querySelectorAll('.seg-btn').forEach(b => { b.disabled = busy; });
}

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
  chrome.runtime.onMessage.addListener((msg, sender) => {
    // 只认当前标签页内容脚本的消息——批量导出等场景下其他标签页
    // 也在广播进度/忙态，不过滤会串台（别的页面导出会禁用本 popup）
    if (!sender || !sender.tab || sender.tab.id !== state.tabId) return;
    if (msg && msg.type === 'INK_PROGRESS') {
      if (!$('state-loading').classList.contains('hidden')) {
        $('loading-text').textContent = msg.text;
      } else {
        const el = $('status-line');
        el.textContent = msg.text;
        el.classList.remove('err');
      }
    }
    // 页面侧忙态广播：popup 关闭重开后据此恢复/解除互斥（导出在页面内继续跑）
    if (msg && msg.type === 'INK_BUSY') {
      setBusy(msg.busy);
      // 「导出完成」只在本 popup 没有发起动作时展示（popup 重开的场景）——
      // 自己发起的导出由动作 handler 给出具体结果，广播先于响应到达，
      // 这里抢着报「完成」会在失败场景下闪一条误导文案
      if (!msg.busy && !state.localAction) status('导出完成');
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

/** popup 里的选择即时写回默认设置——用户的偏好应当被记住（实现见 core/settings.js） */
async function persistPrefs(partial) {
  if (!IS_EXTENSION) return;
  try {
    await InkSettings.update(partial);
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

async function analyze(opts) {
  // 静默模式：结果已在屏时（如切换「导出评论」触发的重分析）不切回加载骨架——
  // 整卡片闪一下再闪回来非常刺眼，原地等数据回来直接更新数字即可
  const quiet = !!(opts && opts.quiet) && $('state-ready') &&
    !$('state-ready').classList.contains('hidden');
  state.analyzing = true;
  if (!quiet) {
    $('state-ready').classList.add('hidden');
    $('state-error').classList.add('hidden');
    $('state-loading').classList.remove('hidden');
    $('loading-text').textContent = '正在研墨，分析页面…';
  } else {
    status('正在更新分析…');
  }
  let res = null;
  try {
    res = await sendToPage({
      type: 'INK_ANALYZE',
      options: {
        includeComments: $('opt-comments').checked,
        // 「重新分析」按钮必须绕过页面侧提取缓存——URL 没变但内容变了时，
        // 不带此标记的分析永远命中旧缓存，按钮等于摆设
        forceRefresh: !!(opts && opts.force),
      },
    });
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  state.analyzing = false;
  if (!res || !res.ok) {
    return showError('页面分析失败', friendlyError(res && res.error));
  }
  renderAnalysis(res);
  // 页面侧仍有导出在跑（popup 关闭重开的场景）：恢复互斥忙态，
  // 结束时页面会广播 INK_BUSY:false 解除
  if (res.exporting) setBusy(true);
  if (quiet) status('');
}

/* ---------- 渲染 ---------- */

function renderAnalysis(res) {
  $('state-loading').classList.add('hidden');
  $('state-error').classList.add('hidden');
  $('state-ready').classList.remove('hidden');

  const badge = $('adapter-badge');
  badge.textContent = res.adapter.name + (res.adapter.badge === 'experimental' ? ' · 实验性' : '');
  badge.className = 'badge ' + res.adapter.badge;

  // 页面树导出：Confluence 专属能力
  $('btn-tree').classList.toggle('hidden', res.adapter.id !== 'confluence');

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

  // 鉴权站点（Confluence/飞书/语雀）的图片带登录态，远程链接在本地 md 里打不开：
  // 本次会话自动切到「本地打包」（只影响这一次，不改用户的全局默认，可手动切回）
  const notes = (res.warnings || []).slice();
  // 目录/容器页正文本来就近乎为空，「0 字」需要解释，否则像出了故障
  if (res.stats.words === 0 && res.adapter.id !== 'generic') {
    notes.push('本页正文几乎为空——可能是目录/容器页。' +
      (res.adapter.id === 'confluence' ? '可直接用「导出页面树」打包全部子页面。' : ''));
  }
  // 只自动切一次——用户手动切回「远程链接」后，重新分析不再强制覆盖
  if (res.adapter.authImages && state.imageStrategy === 'remote' && !state.autoSwitchedZip) {
    state.autoSwitchedZip = true;
    state.imageStrategy = 'zip';
    document.querySelectorAll('.seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.value === 'zip');
    });
    $('btn-download-label').textContent = '下载 ZIP（含图片）';
    notes.push('该站点图片需登录才能访问，已自动切换为「本地打包」，导出的 ZIP 中图片可离线查看（可手动切回远程链接）。');
  }

  const w = $('warnings');
  if (notes.length) {
    w.classList.remove('hidden');
    w.textContent = notes.join(' ');
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
  if (state.busy) return;
  state.localAction = true;
  setBusy(true);
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
    state.localAction = false;
    setBusy(false);
    $('btn-download-label').textContent = state.imageStrategy === 'zip' ? '下载 ZIP（含图片）' : '下载 Markdown';
  }
}

async function doCopy() {
  if (state.busy) return;
  state.localAction = true;
  setBusy(true);
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
  } finally {
    state.localAction = false;
    setBusy(false);
  }
}

async function doPreview() {
  if (state.busy) return;
  state.localAction = true;
  setBusy(true);
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
  } finally {
    state.localAction = false;
    setBusy(false);
  }
}

/* ---------- 事件 ---------- */

async function doExportTree() {
  if (state.busy) return;

  // 续传探测：同根页面有未完成导出时，先问用户「继续（从下一卷起）/重新开始」。
  // confirm 是 popup 里最小的交互——复用现有进度文案机制，不新增 UI 结构。
  let resume = false;
  try {
    const st = await sendToPage({ type: 'INK_TREE_STATUS', options: exportOptions() });
    if (st && st.ok && st.resumable) {
      resume = window.confirm(
        `检测到「${st.rootTitle || '本页面树'}」有未完成的导出（已下载 ${st.volumesDownloaded} 卷、${st.pagesDone} 页）。\n\n` +
        `点「确定」从第 ${st.volumesDownloaded + 1} 卷继续，点「取消」重新开始。`);
    }
  } catch (e) { /* 探测失败按普通导出处理 */ }

  state.localAction = true;
  const btn = $('btn-tree');
  setBusy(true);
  btn.textContent = resume ? '🌳 续传页面树中…' : '🌳 抓取页面树中…';
  try {
    const res = await sendToPage({ type: 'INK_EXPORT_TREE', options: Object.assign(exportOptions(), { resume }) });
    if (!res.ok) throw new Error(res.error);
    const volPart = res.volumes > 1 ? `、共 ${res.volumes} 卷` : '';
    status(`已导出 ${res.pages} 页、${res.images || 0} 张图片${volPart}` +
      (res.failed ? `（${res.failed} 项异常，详见 ZIP 内导出报告）` : ''));
  } catch (e) {
    status('页面树导出失败：' + e.message, true);
  } finally {
    state.localAction = false;
    setBusy(false);
    btn.textContent = '🌳 导出页面树（含全部子页面）';
  }
}

function bindEvents() {
  $('btn-download').addEventListener('click', doDownload);
  $('btn-copy').addEventListener('click', doCopy);
  $('btn-preview').addEventListener('click', doPreview);
  $('btn-tree').addEventListener('click', doExportTree);
  $('btn-settings').addEventListener('click', () => {
    if (IS_EXTENSION) chrome.runtime.openOptionsPage();
  });
  $('btn-reanalyze').addEventListener('click', (e) => {
    e.preventDefault();
    if (IS_EXTENSION && state.tabId && !state.analyzing) analyze({ force: true });
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

  // 切换「导出评论」需要重新分析（评论是异步拉取的）——静默刷新，界面不闪
  $('opt-comments').addEventListener('change', () => {
    persistPrefs({ includeComments: $('opt-comments').checked });
    if (IS_EXTENSION && state.tabId && !state.analyzing) analyze({ quiet: true });
  });
}

/* ---------- 设置 ---------- */

async function loadSettings() {
  return InkSettings.merged();
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
