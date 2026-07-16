/**
 * 摘墨 · Service Worker
 * 职责刻意最小化：注入内容脚本、右键菜单、快捷键。
 * 所有提取/转换/下载都发生在页面上下文（见 core/pipeline.js）。
 */

importScripts('../core/settings.js'); // 设置读写唯一实现（SW 里同样可用）

const CONTENT_FILES = [
  'src/lib/readability.js',
  'src/lib/turndown.js',
  'src/lib/turndown-plugin-gfm.js',
  'src/lib/jszip.min.js',
  'src/core/settings.js',
  'src/core/ir.js',
  'src/core/markdown.js',
  'src/adapters/registry.js',
  'src/adapters/generic.js',
  'src/adapters/custom.js',
  'src/adapters/confluence.js',
  'src/adapters/feishu-docx.js',
  'src/adapters/feishu.js',
  'src/adapters/cn-sites.js',
  'src/adapters/intl-sites.js',
  'src/core/exporter.js',
  'src/core/pipeline.js',
];

/**
 * 注入内容脚本到 tab 的所有 frame（顶层 + 子 frame）。
 * 部分页面正文位于 iframe（邮箱、在线预览器），只注顶层会导出空/残缺。
 *
 * 关键约束：
 * - 已注入的 frame 跳过——重复注入会重放全部脚本（顶层声明重复求值报错 + 白跑）。
 * - 跨源子 frame 若无注入权限，不会出现在探测结果里，静默降级；绝不阻塞顶层。
 * - 返回已就绪的 frame 列表 [{ frameId }]，供 popup 定向分析各帧、跨 frame 选优。
 * @returns {Promise<Array<{frameId:number}>>}
 */
async function injectPipeline(tabId) {
  // 探测各 frame 的注入状态（allFrames）：结果数组里只含扩展有权访问的 frame，
  // 跨源受限子 frame 自动缺席——这正是我们要的优雅降级。
  let probes = null;
  try {
    probes = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => window.__INKMARK_LOADED__ === true,
    });
  } catch (e) { /* allFrames 探测整体失败（页面受限等）：走下面的顶层兜底注入 */ }

  // 探测拿不到任何 frame：退回顶层单帧注入（与历史行为完全一致），让注入给出真实报错
  if (!probes || !probes.length) {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    return [{ frameId: 0 }]; // Chrome 主框架 frameId 恒为 0
  }

  const ready = probes.filter((p) => p && p.result === true).map((p) => p.frameId);
  const pending = probes.filter((p) => p && p.result !== true).map((p) => p.frameId);

  if (pending.length) {
    // 探测能命中的 frame 即可注入文件（同一权限面）；整体失败则逐帧重试，
    // 个别子 frame 注入失败（跨源竞态等）静默跳过，不连累其它 frame。
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: pending }, files: CONTENT_FILES });
      ready.push(...pending);
    } catch (e) {
      for (const frameId of pending) {
        try {
          await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: CONTENT_FILES });
          ready.push(frameId);
        } catch (e2) { /* 该子 frame 注入失败：放弃它，主流程照常 */ }
      }
    }
  }

  // 顶层优先排序：popup 选优默认以顶层为基准
  ready.sort((a, b) => a - b);
  return ready.map((frameId) => ({ frameId }));
}

// 设置的完整默认值与合并逻辑在页面侧（pipeline 读 storage），消息里发空
// options 即可。这里只读一项：imageStrategy——右键/快捷键导出的动作
// （download vs zip）由调用方决定，必须尊重用户设置，
// 否则鉴权站点上会无声导出一份全裂图的 md。
async function getExportAction() {
  const stored = await InkSettings.read();
  return stored.imageStrategy === 'zip' ? 'zip' : 'download';
}

/** 无声入口（右键/快捷键）的结果反馈：工具栏图标角标闪烁 3 秒 */
async function flashBadge(tabId, ok) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: ok ? '#1e8e5a' : '#c0392b' });
    await chrome.action.setBadgeText({ tabId, text: ok ? '✓' : '!' });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    }, 3000);
  } catch (e) { /* tab 已关闭等情况 */ }
}

/* ---------- 右键菜单 ---------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'ink-export-selection',
    title: '摘墨：导出选中内容为 Markdown',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'ink-export-page',
    title: '摘墨：导出本页为 Markdown',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  try {
    await injectPipeline(tab.id);
    let res;
    if (info.menuItemId === 'ink-export-selection') {
      // 选区可能在子 frame 里——定向发往用户实际右键的那个 frame，
      // 否则顶层拿不到子 frame 的 selection，导出「没有选中内容」。
      // 子 frame 需带 frameTargeted 通过页面侧广播守卫。
      const frameId = info.frameId || 0;
      res = await chrome.tabs.sendMessage(
        tab.id,
        { type: 'INK_EXPORT_SELECTION', options: frameId ? { frameTargeted: true } : {} },
        { frameId });
    } else {
      // frameId 必须显式（顶层=0）：allFrames 注入后不带 frameId 是广播，
      // 页面里的子 frame 会各自再导出一份（真实 bug：飞书页面双 ZIP）
      res = await chrome.tabs.sendMessage(tab.id,
        { type: 'INK_EXPORT', action: await getExportAction(), options: {} }, { frameId: 0 });
    }
    await flashBadge(tab.id, !!(res && res.ok));
  } catch (e) {
    console.warn('[inkmark] context menu export failed:', e);
    await flashBadge(tab.id, false);
  }
});

/* ---------- 快捷键：Alt+Shift+M 一键下载 ---------- */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'export-markdown') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await injectPipeline(tab.id);
    // 显式定向顶层，避免 allFrames 广播导致多 frame 重复导出
    const res = await chrome.tabs.sendMessage(tab.id,
      { type: 'INK_EXPORT', action: await getExportAction(), options: {} }, { frameId: 0 });
    await flashBadge(tab.id, !!(res && res.ok));
  } catch (e) {
    console.warn('[inkmark] shortcut export failed:', e);
    await flashBadge(tab.id, false);
  }
});

/* ---------- 供 popup 调用的注入服务 ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'INK_INJECT' && msg.tabId) {
    injectPipeline(msg.tabId)
      // frames：已就绪的各 frame（顶层 + 可注入的子 frame），popup 据此选正文帧
      .then((frames) => sendResponse({ ok: true, frames }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
