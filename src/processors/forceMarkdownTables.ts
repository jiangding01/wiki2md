import { TABLE_PLACEHOLDER_PREFIX } from '../core/constants';

type ForcedTablesResult = {
  tablePlaceholderMap: Map<string, string>;
  forcedCount: number;
  skippedCount: number;
};

const DISALLOWED_IN_CELL_SELECTOR = 'ul,ol,li,pre,blockquote,h1,h2,h3,h4,h5,h6,hr';

function escapeMdTableCell(text: string) {
  return (text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function wrapInlineCode(text: string) {
  const t = (text || '').replace(/\r\n/g, '\n');
  const matches = t.match(/`+/g);
  const max = matches ? Math.max(...matches.map((m) => m.length)) : 0;
  const fence = '`'.repeat(Math.max(1, max + 1));
  return `${fence}${t}${fence}`;
}

function serializeInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (tag === 'br') return '\n';

  // Treat these as "soft blocks" inside a cell; they become line breaks.
  if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
    const inner = Array.from(el.childNodes).map(serializeInline).join('');
    return `${inner}\n`;
  }

  if (tag === 'code') {
    return wrapInlineCode(el.textContent || '');
  }

  if (tag === 'a') {
    const href = (el.getAttribute('href') || '').trim();
    const label = (Array.from(el.childNodes).map(serializeInline).join('') || el.textContent || '').trim();
    if (!href) return label;
    const safeLabel = label || href;
    // Keep as markdown link.
    return `[${safeLabel}](${href})`;
  }

  if (tag === 'img') {
    const src = (el.getAttribute('src') || '').trim();
    if (!src) return '';
    const alt = (el.getAttribute('alt') || '').trim();
    return `![${alt}](${src})`;
  }

  return Array.from(el.childNodes).map(serializeInline).join('');
}

function cellToMarkdown(cell: HTMLElement) {
  const raw = Array.from(cell.childNodes).map(serializeInline).join('');
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
  return escapeMdTableCell(lines.join('<br>'));
}

function isSimpleTable(table: HTMLTableElement) {
  // No nested tables anywhere under this table.
  if (table.querySelectorAll('table').length > 1) return false;

  const rows = Array.from(table.rows);
  if (rows.length === 0) return false;
  const colCount = rows[0].cells.length;
  if (colCount === 0) return false;

  for (const r of rows) {
    if (r.cells.length !== colCount) return false;
    for (const c of Array.from(r.cells)) {
      if ((c as HTMLElement).querySelector(DISALLOWED_IN_CELL_SELECTOR)) return false;
    }
  }

  return true;
}

function buildMarkdownTable(table: HTMLTableElement) {
  const rows = Array.from(table.rows);
  const colCount = rows[0].cells.length;

  const headerIsTh = Array.from(rows[0].cells).some((c) => c.tagName.toLowerCase() === 'th');
  const headerRow = rows[0];
  const bodyRows = rows.slice(1);

  const headerCells = Array.from(headerRow.cells).map((c) => cellToMarkdown(c as any));
  const separatorCells = Array.from({ length: colCount }).map(() => '---');
  const bodyLines = bodyRows.map((r) => Array.from(r.cells).map((c) => cellToMarkdown(c as any)));

  // If no explicit header, we still treat the first row as header to satisfy GFM table syntax.
  void headerIsTh;

  const lines: string[] = [];
  lines.push(`| ${headerCells.join(' | ')} |`);
  lines.push(`| ${separatorCells.join(' | ')} |`);
  bodyLines.forEach((cells) => {
    lines.push(`| ${cells.join(' | ')} |`);
  });
  return `\n\n${lines.join('\n')}\n\n`;
}

export function forceMarkdownTables(clone: HTMLElement, enabled: boolean): ForcedTablesResult {
  const tablePlaceholderMap = new Map<string, string>();
  let forcedCount = 0;
  let skippedCount = 0;

  if (!enabled) return { tablePlaceholderMap, forcedCount, skippedCount };

  const tables = Array.from(clone.querySelectorAll('table')) as HTMLTableElement[];
  tables.forEach((table) => {
    if (!isSimpleTable(table)) {
      skippedCount++;
      return;
    }

    forcedCount++;
    const placeholderKey = `${TABLE_PLACEHOLDER_PREFIX}${forcedCount}`;
    const markdown = buildMarkdownTable(table);
    tablePlaceholderMap.set(placeholderKey, markdown);

    const holder = document.createElement('p');
    holder.textContent = placeholderKey;
    table.replaceWith(holder);
  });

  return { tablePlaceholderMap, forcedCount, skippedCount };
}
