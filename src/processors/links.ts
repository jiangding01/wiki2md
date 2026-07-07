const ABSOLUTE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'data:']);

function isProbablyRelative(href: string) {
  const h = (href || '').trim();
  if (!h) return false;
  if (h.startsWith('#')) return false;
  if (h.startsWith('javascript:')) return false;
  if (h.startsWith('about:')) return false;
  if (h.startsWith('chrome:')) return false;
  if (h.startsWith('edge:')) return false;
  if (h.startsWith('file:')) return false;
  if (h.startsWith('blob:')) return false;

  // protocol-relative
  if (h.startsWith('//')) return true;

  try {
    const u = new URL(h);
    return !ABSOLUTE_SCHEMES.has(u.protocol);
  } catch {
    // Not a valid absolute URL, treat as relative.
    return true;
  }
}

export function rewriteRelativeLinksToAbsolute(clone: HTMLElement, baseUrl: string) {
  const anchors = Array.from(clone.querySelectorAll('a[href]')) as HTMLAnchorElement[];
  anchors.forEach((a) => {
    const raw = (a.getAttribute('href') || '').trim();
    if (!raw) return;
    if (!isProbablyRelative(raw)) return;
    try {
      const abs = new URL(raw, baseUrl).href;
      a.setAttribute('href', abs);
    } catch {
      // ignore
    }
  });
}

