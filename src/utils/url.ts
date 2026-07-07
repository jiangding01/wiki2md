export function getUrlBasename(u: string) {
  try {
    const url = new URL(u);
    const raw = decodeURIComponent(url.pathname.split('/').pop() || '');
    return raw;
  } catch {
    return '';
  }
}

export function extFromUrl(u: string) {
  try {
    const url = new URL(u);
    const pathname = url.pathname || '';
    const dotIdx = pathname.lastIndexOf('.');
    if (dotIdx < 0) return null;
    const ext = pathname.slice(dotIdx).toLowerCase();
    if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return null;
    return ext;
  } catch {
    return null;
  }
}

export function pickBestFromSrcset(srcset: string) {
  const candidates = (srcset || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const pieces = part.split(/\s+/).filter(Boolean);
      const url = pieces[0];
      const descriptor = pieces[1] || '';
      let score = 1;
      if (descriptor.endsWith('w')) {
        const n = parseInt(descriptor.slice(0, -1), 10);
        if (!Number.isNaN(n)) score = n;
      } else if (descriptor.endsWith('x')) {
        const n = parseFloat(descriptor.slice(0, -1));
        if (!Number.isNaN(n)) score = n * 1_000;
      }
      return { url, score };
    });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].url;
}

export function extractCssUrls(cssText: string) {
  const urls: string[] = [];
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
  let match: RegExpExecArray | null = null;
  while ((match = re.exec(cssText))) {
    const raw = (match[2] || '').trim();
    if (!raw) continue;
    urls.push(raw);
  }
  return urls;
}

export function isDataUrl(u: string) {
  return /^data:/i.test(u || '');
}

export function dataUrlToBlob(dataUrl: string): { blob: Blob; contentType: string | null } {
  const match = (dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!match) {
    return { blob: new Blob([dataUrl], { type: 'application/octet-stream' }), contentType: null };
  }
  const contentType = (match[1] || '').trim() || null;
  const isBase64 = !!match[2];
  const dataPart = match[3] || '';

  if (isBase64) {
    const binary = atob(dataPart);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { blob: new Blob([bytes], { type: contentType || 'application/octet-stream' }), contentType };
  }

  const decoded = decodeURIComponent(dataPart);
  return { blob: new Blob([decoded], { type: contentType || 'application/octet-stream' }), contentType };
}

export function resolveAbsoluteUrl(raw: string, baseUrl: string) {
  if (isDataUrl(raw)) return raw;
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return null;
  }
}

