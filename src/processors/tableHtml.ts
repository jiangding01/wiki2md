function stripAttrs(el: Element, allow: Set<string>) {
  const attrs = Array.from(el.attributes);
  attrs.forEach((attr) => {
    const name = attr.name.toLowerCase();
    if (!allow.has(name)) el.removeAttribute(attr.name);
  });
}

export function minimizeTableHtml(clone: HTMLElement) {
  // Width-only metadata in Confluence tables: remove to reduce noise.
  clone.querySelectorAll('colgroup, col').forEach((el) => el.remove());

  const tables = Array.from(clone.querySelectorAll('table'));
  tables.forEach((table) => {
    // For table structural tags: strip all attributes.
    const structural = table.querySelectorAll('table,thead,tbody,tfoot,tr,th,td');
    structural.forEach((el) => stripAttrs(el, new Set<string>()));

    // Inside cells, keep only essential link/image attributes.
    table.querySelectorAll('a[href]').forEach((a) => stripAttrs(a, new Set(['href', 'title'])));
    table.querySelectorAll('img[src]').forEach((img) => stripAttrs(img, new Set(['src', 'alt', 'title'])));

    // Remove style/class/id/data*/aria*/role attributes from everything in the table.
    table.querySelectorAll('*').forEach((el) => {
      const attrs = Array.from(el.attributes);
      attrs.forEach((attr) => {
        const n = attr.name.toLowerCase();
        if (
          n === 'style' ||
          n === 'class' ||
          n === 'id' ||
          n === 'role' ||
          n.startsWith('data-') ||
          n.startsWith('aria-')
        ) {
          el.removeAttribute(attr.name);
        }
      });
    });
  });
}

