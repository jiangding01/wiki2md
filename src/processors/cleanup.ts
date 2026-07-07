export function removeEmptyHeadings(clone: HTMLElement) {
  clone.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    const text = (h.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return;
    // Remove headings that would render as stray "#", "##", etc. in Markdown.
    h.remove();
  });
}

