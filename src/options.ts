import { DEFAULT_OPTIONS, getOptions, normalizeAllowlist, setOptions, type Wiki2mdOptions } from './core/options';

function qs<T extends HTMLElement>(id: string) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`页面元素不存在：#${id}`);
  return el as T;
}

type StatusKind = 'info' | 'success' | 'error' | 'warn';

let initialSnapshot = '';
let statusTimer: number | null = null;

function serializeOptions(opts: Wiki2mdOptions) {
  return JSON.stringify(opts);
}

function clampConcurrency(raw: unknown) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_OPTIONS.behaviors.imageDownloadConcurrency;
  const v = Math.floor(n);
  return Math.max(1, Math.min(12, v));
}

function collectOptionsFromForm(): Wiki2mdOptions {
  const allowlist = normalizeAllowlist(qs<HTMLTextAreaElement>('allowlist').value);
  const imageDownloadConcurrency = clampConcurrency(qs<HTMLInputElement>('img_concurrency').value);

  return {
    ...DEFAULT_OPTIONS,
    allowlist,
    platforms: {
      confluence: qs<HTMLInputElement>('platform_confluence').checked,
      feishu: qs<HTMLInputElement>('platform_feishu').checked,
      wechat: qs<HTMLInputElement>('platform_wechat').checked
    },
    behaviors: {
      rewriteRelativeLinksToAbsolute: qs<HTMLInputElement>('rewrite_links').checked,
      forceMarkdownTables: qs<HTMLInputElement>('force_md_tables').checked,
      imageDownloadConcurrency
    }
  };
}

function applyOptionsToForm(opts: Wiki2mdOptions) {
  qs<HTMLTextAreaElement>('allowlist').value = (opts.allowlist || []).join('\n');
  qs<HTMLInputElement>('platform_confluence').checked = opts.platforms.confluence;
  qs<HTMLInputElement>('platform_feishu').checked = opts.platforms.feishu;
  qs<HTMLInputElement>('platform_wechat').checked = opts.platforms.wechat;
  qs<HTMLInputElement>('rewrite_links').checked = opts.behaviors.rewriteRelativeLinksToAbsolute;
  qs<HTMLInputElement>('force_md_tables').checked = opts.behaviors.forceMarkdownTables;
  qs<HTMLInputElement>('img_concurrency').value = String(opts.behaviors.imageDownloadConcurrency);
  qs<HTMLInputElement>('img_concurrency_range').value = String(opts.behaviors.imageDownloadConcurrency);
}

function setStatus(text: string, kind: StatusKind = 'info', autoClearMs = 2400) {
  const el = qs<HTMLDivElement>('status');
  el.textContent = text;
  el.className = `status ${kind === 'info' ? '' : kind}`.trim();

  if (statusTimer) window.clearTimeout(statusTimer);
  if (autoClearMs <= 0) return;

  statusTimer = window.setTimeout(() => {
    el.textContent = '';
    el.className = 'status';
  }, autoClearMs);
}

function isDirty() {
  return serializeOptions(collectOptionsFromForm()) !== initialSnapshot;
}

function updateDirtyHint() {
  const saveBtn = qs<HTMLButtonElement>('save');
  const dirtyHint = qs<HTMLSpanElement>('dirty_hint');
  const dirty = isDirty();

  saveBtn.disabled = !dirty;
  dirtyHint.textContent = dirty ? '当前状态：有未保存修改' : '当前状态：已同步';
}

function updateAllowlistMeta() {
  const allowlist = normalizeAllowlist(qs<HTMLTextAreaElement>('allowlist').value);
  const wildcardCount = allowlist.filter((item) => item.startsWith('*.')).length;
  const exactCount = allowlist.length - wildcardCount;
  qs<HTMLSpanElement>('allowlist_meta').textContent = `共 ${allowlist.length} 条规则（精确 ${exactCount} / 通配 ${wildcardCount}）`;
}

function syncConcurrencyFrom(source: 'range' | 'number') {
  const numberInput = qs<HTMLInputElement>('img_concurrency');
  const rangeInput = qs<HTMLInputElement>('img_concurrency_range');
  const raw = source === 'range' ? rangeInput.value : numberInput.value;
  const value = clampConcurrency(raw);
  numberInput.value = String(value);
  rangeInput.value = String(value);
  qs<HTMLSpanElement>('concurrency_meta').textContent = `图片下载并发：${value}（推荐 4-6）`;
}

function renderFormState() {
  syncConcurrencyFrom('number');
  updateAllowlistMeta();
  updateDirtyHint();
}

function updateLastSavedLabel(prefix: string) {
  const now = new Date();
  const formatted = now.toLocaleString('zh-CN', { hour12: false });
  qs<HTMLSpanElement>('last_saved').textContent = `${prefix}：${formatted}`;
}

async function load() {
  const opts = await getOptions();
  applyOptionsToForm(opts);
  initialSnapshot = serializeOptions(collectOptionsFromForm());
  renderFormState();
  updateLastSavedLabel('最近加载');
}

async function save() {
  const saveBtn = qs<HTMLButtonElement>('save');
  if (saveBtn.disabled) return;

  try {
    saveBtn.disabled = true;
    const next = collectOptionsFromForm();
    await setOptions(next);
    initialSnapshot = serializeOptions(next);
    renderFormState();
    updateLastSavedLabel('最近保存');
    setStatus('设置已保存。', 'success');
  } catch (e: any) {
    setStatus(`保存失败：${e?.message || String(e)}`, 'error', 3600);
    updateDirtyHint();
  }
}

async function resetDefaults() {
  if (isDirty()) {
    const ok = window.confirm('检测到未保存修改，确认恢复默认设置吗？');
    if (!ok) return;
  }

  try {
    await setOptions(DEFAULT_OPTIONS);
    applyOptionsToForm(DEFAULT_OPTIONS);
    initialSnapshot = serializeOptions(collectOptionsFromForm());
    renderFormState();
    updateLastSavedLabel('已重置');
    setStatus('已恢复默认设置。', 'warn');
  } catch (e: any) {
    setStatus(`重置失败：${e?.message || String(e)}`, 'error', 3600);
  }
}

function normalizeAllowlistInPlace() {
  const textarea = qs<HTMLTextAreaElement>('allowlist');
  textarea.value = normalizeAllowlist(textarea.value).join('\n');
  renderFormState();
  setStatus('已整理允许列表。', 'info');
}

function bindFormEvents() {
  const trackIds = [
    'allowlist',
    'platform_confluence',
    'platform_feishu',
    'platform_wechat',
    'rewrite_links',
    'force_md_tables'
  ];

  trackIds.forEach((id) => {
    qs<HTMLElement>(id).addEventListener('input', renderFormState);
    qs<HTMLElement>(id).addEventListener('change', renderFormState);
  });

  qs<HTMLInputElement>('img_concurrency').addEventListener('input', () => {
    syncConcurrencyFrom('number');
    updateDirtyHint();
  });

  qs<HTMLInputElement>('img_concurrency_range').addEventListener('input', () => {
    syncConcurrencyFrom('range');
    updateDirtyHint();
  });

  qs<HTMLButtonElement>('normalize_allowlist').addEventListener('click', normalizeAllowlistInPlace);
  qs<HTMLButtonElement>('save').addEventListener('click', () => void save());
  qs<HTMLButtonElement>('reset').addEventListener('click', () => void resetDefaults());

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault();
      void save();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    bindFormEvents();
    await load();
    setStatus('配置已加载。修改后请点击“保存设置”。', 'info');
  } catch (e: any) {
    setStatus(`加载失败：${e?.message || String(e)}`, 'error', 5000);
  }
});
