import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

function replaceFromMap(markdown: string, map: Map<string, string>, wrapValue?: (value: string) => string) {
  const entries = Array.from(map.entries()).sort((a, b) => b[0].length - a[0].length);
  for (const [key, rawValue] of entries) {
    const value = wrapValue ? wrapValue(rawValue) : rawValue;
    markdown = markdown.split(key).join(value);
  }
  return markdown;
}

export function convertDomToMarkdown(params: {
  clone: HTMLElement;
  nestedTableMap: Map<string, string>;
  codePlaceholderMap: Map<string, string>;
  anchorPlaceholderMap: Map<string, string>;
  tablePlaceholderMap?: Map<string, string>;
}) {
  const { clone, nestedTableMap, codePlaceholderMap, anchorPlaceholderMap, tablePlaceholderMap } = params;

  const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  turndownService.use(gfm);

  let markdown = turndownService.turndown(clone.innerHTML);

  // Replace placeholders in a collision-safe order (e.g. PLACEHOLDER10 before PLACEHOLDER1).
  // NOTE: Table markdown may contain nested-table placeholders, so table replacement must happen
  // before nested-table replacement.
  if (tablePlaceholderMap) {
    markdown = replaceFromMap(markdown, tablePlaceholderMap);
  }
  markdown = replaceFromMap(markdown, nestedTableMap);
  markdown = markdown.split('{{BR}}').join('<br>');
  markdown = markdown.replace(/(<br\s*\/?>\s*){2,}/gi, '<br>');
  markdown = markdown.replace(/&#124;(\s*)(?=\||\r?\n|$)/g, '$1');

  markdown = replaceFromMap(markdown, codePlaceholderMap);
  markdown = replaceFromMap(markdown, anchorPlaceholderMap, (html) => `\n${html}\n`);

  return markdown;
}
