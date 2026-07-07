export function sanitizeFilenamePart(input: string) {
  return (input || '')
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function normalizeCodeText(text: string) {
  return (text || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
}

export function escapeHtml(text: string) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function cssEscapeId(id: string) {
  const esc = (globalThis as any).CSS?.escape;
  if (typeof esc === 'function') return esc(id);
  return (id || '').replace(/[^a-zA-Z0-9_-]/g, (s) => `\\${s}`);
}

export function slugifyAnchorText(text: string) {
  const raw = (text || '').trim().toLowerCase();
  if (!raw) return 'section';
  let s = raw.replace(/\s+/g, '-');
  s = s.replace(/[^a-z0-9\u4e00-\u9fa5_-]/g, '-');
  s = s.replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  return s || 'section';
}

