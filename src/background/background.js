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

async function injectPipeline(tabId) {
  // 已注入则跳过：重复注入会把所有脚本文件重放一遍——
  // 顶层声明重复求值（报错噪音）+ 白白重跑，一次探测省掉这两样
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__INKMARK_LOADED__ === true,
    });
    if (probe && probe.result) return;
  } catch (e) { /* 探测失败（页面受限等）时按未注入处理，让下面的注入给出真实报错 */ }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_FILES,
  });
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
      res = await chrome.tabs.sendMessage(tab.id, { type: 'INK_EXPORT_SELECTION', options: {} });
    } else {
      res = await chrome.tabs.sendMessage(tab.id, { type: 'INK_EXPORT', action: await getExportAction(), options: {} });
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
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'INK_EXPORT', action: await getExportAction(), options: {} });
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
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
