export function parseContentDispositionFilename(contentDisposition: string | null) {
  if (!contentDisposition) return null;
  const starMatch = contentDisposition.match(/filename\*\s*=\s*([^']*)''([^;]+)/i);
  if (starMatch) {
    try {
      const encoded = starMatch[2].trim();
      return decodeURIComponent(encoded);
    } catch {
      // ignore
    }
  }
  const match = contentDisposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  return match ? match[1].trim() : null;
}

export function extFromContentType(contentType: string | null) {
  if (!contentType) return null;
  const ct = contentType.split(';')[0]?.trim().toLowerCase();
  if (!ct) return null;
  if (ct === 'image/jpeg') return '.jpg';
  if (ct === 'image/png') return '.png';
  if (ct === 'image/gif') return '.gif';
  if (ct === 'image/webp') return '.webp';
  if (ct === 'image/svg+xml') return '.svg';
  if (ct === 'image/bmp') return '.bmp';
  if (ct === 'image/tiff') return '.tiff';
  if (ct === 'image/x-icon' || ct === 'image/vnd.microsoft.icon') return '.ico';
  return null;
}

