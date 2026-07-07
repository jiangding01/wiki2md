/**
 * 摘墨 · Service Worker
 * 职责刻意最小化：注入内容脚本、右键菜单、快捷键。
 * 所有提取/转换/下载都发生在页面上下文（见 core/pipeline.js）。
 */

const CONTENT_FILES = [
  'src/lib/readability.js',
  'src/lib/turndown.js',
  'src/lib/turndown-plugin-gfm.js',
  'src/lib/jszip.min.js',
  'src/core/ir.js',
  'src/core/markdown.js',
  'src/adapters/registry.js',
  'src/adapters/generic.js',
  'src/adapters/custom.js',
  'src/adapters/confluence.js',
  'src/adapters/feishu.js',
  'src/adapters/cn-sites.js',
  'src/adapters/intl-sites.js',
  'src/core/exporter.js',
  'src/core/pipeline.js',
];

async function injectPipeline(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_FILES,
  });
}

// 设置的完整默认值与合并逻辑在 pipeline.js（页面侧读 storage）；
// 这里无需再传 options——发空对象即可，pipeline 自行读取用户设置。
async function getSettings() {
  return {};
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
    const settings = await getSettings();
    if (info.menuItemId === 'ink-export-selection') {
      await chrome.tabs.sendMessage(tab.id, { type: 'INK_EXPORT_SELECTION', options: settings });
    } else {
      await chrome.tabs.sendMessage(tab.id, { type: 'INK_EXPORT', action: 'download', options: settings });
    }
  } catch (e) {
    console.warn('[inkmark] context menu export failed:', e);
  }
});

/* ---------- 快捷键：Alt+Shift+M 一键下载 ---------- */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'export-markdown') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await injectPipeline(tab.id);
    const settings = await getSettings();
    await chrome.tabs.sendMessage(tab.id, { type: 'INK_EXPORT', action: 'download', options: settings });
  } catch (e) {
    console.warn('[inkmark] shortcut export failed:', e);
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
