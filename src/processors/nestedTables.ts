export function extractNestedTables(clone: HTMLElement) {
  const nestedTableMap = new Map<string, string>();
  let nestedPlaceholderCount = 0;

  const stripAttrs = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    const allow = new Set<string>();
    if (tag === 'td' || tag === 'th') {
      allow.add('rowspan');
      allow.add('colspan');
    } else if (tag === 'a') {
      allow.add('href');
      allow.add('title');
    } else if (tag === 'img') {
      allow.add('src');
      allow.add('alt');
      allow.add('title');
    }

    const attrs = Array.from(el.attributes);
    attrs.forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (allow.has(name)) return;
      el.removeAttribute(attr.name);
    });
  };

  while (true) {
    const nestedTables = clone.querySelectorAll('td table, th table');
    if (nestedTables.length === 0) break;
    const deepestTables = Array.from(nestedTables).filter((t) => !t.querySelector('table'));
    if (deepestTables.length === 0) break;
    deepestTables.forEach((t) => {
      nestedPlaceholderCount++;
      const key = `NESTEDTABLEPLACEHOLDER${nestedPlaceholderCount}`;

      // Reduce noise while keeping functional attrs (href/src/rowspan/colspan).
      t.querySelectorAll('colgroup, col').forEach((el) => el.remove());
      [t, ...Array.from(t.querySelectorAll('*'))].forEach(stripAttrs);

      const html = t.outerHTML
        .replace(/>\s+</g, '><')
        .replace(/[\r\n]+/g, ' ')
        // Avoid breaking outer markdown tables when nested HTML is in a cell.
        .replace(/\|/g, '&#124;');
      nestedTableMap.set(key, html);
      t.replaceWith(document.createTextNode(key));
    });
  }

  return nestedTableMap;
}
