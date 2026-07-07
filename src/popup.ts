import { getOptions, isHostAllowed } from './core/options';

type StatusKind = 'info' | 'success' | 'error';

function qs<T extends HTMLElement>(id: string) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`页面元素不存在：#${id}`);
  return el as T;
}

const btn = qs<HTMLButtonElement>('downloadBtn');
const btnLabel = qs<HTMLSpanElement>('downloadBtnLabel');
const status = qs<HTMLDivElement>('status');
const pageMetaValue = qs<HTMLDivElement>('pageMetaValue');
const openOptionsBtn = qs<HTMLButtonElement>('openOptionsBtn');
const refreshBtn = qs<HTMLButtonElement>('refreshBtn');

const state = {
  busy: false,
  canExport: false,
  activeTabId: null as number | null,
  activeTabUrl: ''
};

function setStatus(text: string, kind: StatusKind = 'info') {
  status.textContent = text;
  status.className = kind;
}

function setCanExport(next: boolean) {
  state.canExport = next;
  if (!state.busy) btn.disabled = !next;
}

function setBusy(busy: boolean, label?: string) {
  state.busy = busy;
  btn.dataset.busy = busy ? 'true' : 'false';
  btn.disabled = busy || !state.canExport;
  btnLabel.textContent = label || (busy ? '导出中...' : '开始导出 .zip');
  refreshBtn.disabled = busy;
  openOptionsBtn.disabled = busy;
}

function formatTabDisplay(tabUrl: string) {
  try {
    const u = new URL(tabUrl);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return tabUrl || '未知页面';
  }
}

async function validateExportability(tabUrl: string) {
  let u: URL;
  try {
    u = new URL(tabUrl);
  } catch {
    throw new Error('无法识别当前页面 URL');
  }

  if (!/^https?:$/.test(u.protocol)) {
    throw new Error('仅支持 http/https 页面');
  }

  const options = await getOptions();
  if (!isHostAllowed(u.hostname, options.allowlist)) {
    throw new Error('当前网站不在允许列表中，请在插件设置中添加域名或清空允许列表');
  }
}

async function refreshActiveTabContext() {
  setStatus('正在检查当前页面...', 'info');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('找不到活动标签页');

    const tabUrl = tab.url || '';
    state.activeTabId = tab.id;
    state.activeTabUrl = tabUrl;
    pageMetaValue.textContent = formatTabDisplay(tabUrl);

    await validateExportability(tabUrl);
    setCanExport(true);
    setStatus('页面可导出，点击上方按钮开始。', 'info');
  } catch (e: any) {
    setCanExport(false);
    setStatus(e?.message || String(e), 'error');
  }
}

async function runExport() {
  if (state.busy) return;
  setBusy(true, '正在准备导出...');
  setStatus('正在注入导出脚本...', 'info');

  try {
    if (!state.activeTabId) {
      await refreshActiveTabContext();
    }
    if (!state.activeTabId || !state.activeTabUrl) throw new Error('找不到活动标签页');

    await validateExportability(state.activeTabUrl);
    await chrome.scripting.executeScript({
      target: { tabId: state.activeTabId },
      files: ['content.js']
    });

    setStatus('已开始导出，请查看页面中的进度提示。', 'info');
    setBusy(true, '导出中...');
  } catch (e: any) {
    setStatus(`导出失败：${e?.message || String(e)}`, 'error');
    setBusy(false, '开始导出 .zip');
  }
}

btn.addEventListener('click', () => {
  void runExport();
});

refreshBtn.addEventListener('click', () => {
  void refreshActiveTabContext();
});

openOptionsBtn.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message: any) => {
  if (message.type === 'DOWNLOAD_COMPLETE') {
    setBusy(false, '开始导出 .zip');
    setStatus('下载完成，窗口即将自动关闭。', 'success');
    setTimeout(() => window.close(), 420);
  } else if (message.type === 'DOWNLOAD_ERROR') {
    setBusy(false, '开始导出 .zip');
    setStatus(`导出失败：${message.error || '未知错误'}`, 'error');
  } else if (message.type === 'STATUS_UPDATE') {
    setStatus(message.text || '处理中...', 'info');
  }
});

void refreshActiveTabContext();
