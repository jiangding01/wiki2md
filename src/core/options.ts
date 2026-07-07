import { FORCE_MARKDOWN_TABLES, MAX_ASSET_DOWNLOAD_CONCURRENCY } from './constants';

export type Wiki2mdOptions = {
  allowlist: string[];
  platforms: {
    confluence: boolean;
    feishu: boolean;
    wechat: boolean;
  };
  behaviors: {
    rewriteRelativeLinksToAbsolute: boolean;
    forceMarkdownTables: boolean;
    imageDownloadConcurrency: number;
  };
};

export const DEFAULT_OPTIONS: Wiki2mdOptions = {
  allowlist: [],
  platforms: {
    confluence: true,
    feishu: false,
    wechat: false
  },
  behaviors: {
    rewriteRelativeLinksToAbsolute: true,
    forceMarkdownTables: FORCE_MARKDOWN_TABLES,
    imageDownloadConcurrency: MAX_ASSET_DOWNLOAD_CONCURRENCY
  }
};

function clampInt(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  const v = Math.floor(n);
  return Math.min(max, Math.max(min, v));
}

function sanitizeOptions(stored: any): Wiki2mdOptions {
  const allowlistRaw = Array.isArray(stored?.allowlist) ? stored.allowlist : [];
  const platforms = stored?.platforms || {};
  const behaviors = stored?.behaviors || {};

  const allowlistItems: string[] = allowlistRaw
    .filter((s: unknown): s is string => typeof s === 'string')
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);

  const allowlist: string[] = Array.from(
    new Set<string>(allowlistItems)
  );

  return {
    allowlist,
    platforms: {
      confluence: platforms.confluence !== false,
      feishu: platforms.feishu === true,
      wechat: platforms.wechat === true
    },
    behaviors: {
      rewriteRelativeLinksToAbsolute: behaviors.rewriteRelativeLinksToAbsolute !== false,
      forceMarkdownTables: behaviors.forceMarkdownTables !== false,
      imageDownloadConcurrency: clampInt(
        Number(behaviors.imageDownloadConcurrency ?? DEFAULT_OPTIONS.behaviors.imageDownloadConcurrency),
        1,
        12
      )
    }
  };
}

export async function getOptions(): Promise<Wiki2mdOptions> {
  const raw = await chrome.storage.sync.get('wiki2mdOptions');
  return sanitizeOptions((raw as any)?.wiki2mdOptions || {});
}

export async function setOptions(options: Wiki2mdOptions) {
  await chrome.storage.sync.set({ wiki2mdOptions: sanitizeOptions(options) });
}

export function normalizeAllowlist(text: string): string[] {
  const lines = (text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  // De-dup while keeping order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

export function isHostAllowed(hostname: string, allowlist: string[]) {
  if (!allowlist || allowlist.length === 0) return true; // default: allow all
  const host = (hostname || '').toLowerCase();
  if (!host) return false;

  for (const raw of allowlist) {
    const rule = (raw || '').trim().toLowerCase();
    if (!rule) continue;
    if (rule === host) return true;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2);
      if (!suffix) continue;
      if (host === suffix) return true;
      if (host.endsWith(`.${suffix}`)) return true;
    }
  }
  return false;
}
