import { CODE_PLACEHOLDER_PREFIX } from '../core/constants';
import type { StatusReporter } from '../core/status';
import { escapeHtml, normalizeCodeText } from '../utils/strings';

const KNOWN_LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  sh: 'bash',
  shell: 'bash',
  md: 'markdown',
  plaintext: 'text',
  plain: 'text'
};

const NON_LANGUAGE_CLASSES = new Set([
  'syntaxhighlighter',
  'nogutter',
  'gutter',
  'toolbar',
  'container',
  'code',
  'plain',
  'spaces',
  'value',
  'string',
  'keyword',
  'comments',
  'comment',
  'punctuation'
]);

function stripCodeUiNoise(text: string) {
  let t = normalizeCodeText(text || '');
  // Some Confluence syntax highlighters prepend UI labels into textContent when extraction falls back.
  t = t.replace(/^\s*(?:展开源码|查看源码)\s*/i, '');
  t = t.replace(/^\s*expand\s+source\s*\?\s*/i, '');
  t = t.replace(/^\s*expand\s+source\s*/i, '');
  t = t.replace(/^\s*\?\s*/i, '');
  return t;
}

function cleanCodeTitle(raw: string | null) {
  const t = normalizeCodeText(raw || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  // Remove common toolbar/CTA labels accidentally captured from Confluence widgets.
  const cleaned = t
    .replace(/\bexpand\s+source\b/gi, '')
    .replace(/展开源码/g, '')
    .replace(/查看源码/g, '')
    .replace(/(^|\s)\?(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || null;
}

function inferLanguageFromElement(el: Element) {
  const candidates: string[] = [];
  el.classList.forEach((cls) => {
    const c = cls.trim().toLowerCase();
    if (!c) return;
    if (c.startsWith('sh-')) candidates.push(c.slice(3));
    candidates.push(c);
  });

  el.querySelectorAll('code').forEach((codeEl) => {
    const cls = (codeEl.getAttribute('class') || '').trim();
    if (!cls) return;
    const firstToken = cls.split(/\s+/)[0]?.toLowerCase();
    if (firstToken) candidates.push(firstToken);
    const langMatch = cls.match(/\b(language|lang)-([a-z0-9_+-]+)\b/i);
    if (langMatch) candidates.push(langMatch[2].toLowerCase());
  });

  const normalized = candidates
    .map((c) => (KNOWN_LANG_ALIASES[c] || c).toLowerCase())
    .map((c) => c.replace(/[^a-z0-9_+-]/g, ''))
    .filter((c) => c && !NON_LANGUAGE_CLASSES.has(c));

  const preferred = ['sql', 'json', 'yaml', 'bash', 'javascript', 'typescript', 'java', 'python', 'go', 'xml', 'html', 'css'];
  for (const p of preferred) {
    if (normalized.includes(p)) return p;
  }
  return normalized[0] || null;
}

function parseMacroLanguage(macroEl: Element) {
  const raw = (macroEl.getAttribute('data-macro-parameters') || '').trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  const langMatch =
    lowered.match(/(?:^|[|,;\s])(?:language|lang)\s*=\s*([a-z0-9_+-]+)/i) ||
    lowered.match(/"(?:language|lang)"\s*:\s*"([a-z0-9_+-]+)"/i);

  if (!langMatch) return null;
  const lang = (langMatch[1] || '').trim().toLowerCase();
  if (!lang) return null;
  return KNOWN_LANG_ALIASES[lang] || lang;
}

function inferLanguageFromCodeText(code: string) {
  const text = normalizeCodeText(code).trim();
  if (!text) return null;

  const trimmed = text.trimStart();
  const head = text.slice(0, 240).toUpperCase();

  const isSql =
    /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|TRUNCATE|REPLACE)\b/i.test(text) ||
    /\bCREATE\s+TABLE\b/i.test(head) ||
    /\bALTER\s+TABLE\b/i.test(head) ||
    /\bENGINE\s*=\s*[A-Z0-9_]+\b/i.test(head);
  if (isSql) return 'sql';

  const isDiff =
    /^diff --git\b/m.test(text) ||
    /^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@/m.test(text) ||
    /^(\+\+\+|---)\s/m.test(text);
  if (isDiff) return 'diff';

  const isJsonCandidate = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (isJsonCandidate) {
    const hasColon = /"\s*:\s*/.test(text);
    if (hasColon) return 'json';
  }

  const isYaml = /^---\s*$/m.test(text) || (/^[a-z0-9_.-]+\s*:\s+.+$/im.test(text) && !/[{};]/.test(text));
  if (isYaml) return 'yaml';

  const isHtmlOrXml =
    /^<\?xml\b/i.test(trimmed) ||
    /^<!doctype\s+html\b/i.test(trimmed) ||
    /^<([a-z][a-z0-9-]*)(\s|>)/i.test(trimmed);
  if (isHtmlOrXml) {
    if (/^<!doctype\s+html\b/i.test(trimmed) || /<\/(html|body|div|span|script|style)>/i.test(text)) return 'html';
    return 'xml';
  }

  const isBash = /^#!/.test(trimmed) || /^\s*(export|cd|ls|cat|curl|wget|npm|yarn|pnpm)\b/m.test(text);
  if (isBash) return 'bash';

  return null;
}

function pickFenceForCode(code: string) {
  let maxTicks = 0;
  const re = /`{3,}/g;
  let match: RegExpExecArray | null = null;
  while ((match = re.exec(code))) {
    maxTicks = Math.max(maxTicks, match[0].length);
  }
  return '`'.repeat(Math.max(3, maxTicks + 1));
}

function buildFencedCodeMarkdown(code: string, language: string | null, title: string | null) {
  const normalized = normalizeCodeText(code);
  const fence = pickFenceForCode(normalized);
  const info = language ? language : '';
  const parts: string[] = [];
  if (title) {
    parts.push(`**${title}**`);
    parts.push('');
  }
  parts.push(`${fence}${info ? info : ''}`);
  parts.push(normalized.replace(/\n$/, ''));
  parts.push(fence);
  return `\n\n${parts.join('\n')}\n\n`;
}

function buildTableCellCodeHtml(code: string, language: string | null, title: string | null) {
  const normalized = normalizeCodeText(code);
  const langClass = language ? ` class="language-${escapeHtml(language)}"` : '';
  const titleHtml = title ? `<strong>${escapeHtml(title)}</strong><br>` : '';
  const lines = normalized.split('\n');
  const codePieces = lines.map((line) => `<code${langClass}>${escapeHtml(line).replace(/\|/g, '&#124;')}</code>`);
  return `${titleHtml}${codePieces.join('<br>')}`;
}

function extractCodeFromSyntaxHighlighter(root: Element) {
  // Prefer structured code cells to avoid picking up toolbar labels like "expand source" / "?".
  const codeCell = root.querySelector('td.code') || root.querySelector('.code');
  if (codeCell) {
    const lineEls = Array.from(codeCell.querySelectorAll('div.line'));
    if (lineEls.length > 0) {
      const outLines = lineEls.map((line) => normalizeCodeText(line.textContent || '').replace(/\s+$/g, ''));
      while (outLines.length > 0 && outLines[0].trim() === '') outLines.shift();
      while (outLines.length > 0 && outLines[outLines.length - 1].trim() === '') outLines.pop();
      return outLines.join('\n');
    }

    const preInCodeCell = codeCell.querySelector('pre');
    if (preInCodeCell) {
      return stripCodeUiNoise(preInCodeCell.textContent || '').trim();
    }
  }

  const container = root.querySelector('td.code .container') || root.querySelector('.code .container') || root.querySelector('.container');
  if (container) {
    const lines = Array.from(container.querySelectorAll('.line'));
    if (lines.length > 0) {
      const outLines = lines.map((line) => normalizeCodeText(line.textContent || '').replace(/\s+$/g, ''));
      while (outLines.length > 0 && outLines[0].trim() === '') outLines.shift();
      while (outLines.length > 0 && outLines[outLines.length - 1].trim() === '') outLines.pop();
      return outLines.join('\n');
    }
    return stripCodeUiNoise(container.textContent || '').trim();
  }
  const pre = root.querySelector('pre');
  if (pre) return stripCodeUiNoise(pre.textContent || '').trim();
  return stripCodeUiNoise(root.textContent || '').trim();
}

export type CodeBlockProcessingResult = {
  codePlaceholderMap: Map<string, string>;
  codeCounter: number;
};

export function formatCodeBlocks(clone: HTMLElement, status: StatusReporter): CodeBlockProcessingResult {
  const codePlaceholderMap = new Map<string, string>();
  let codeCounter = 0;

  const replaceWithPlaceholder = (el: Element, markdownSnippet: string) => {
    codeCounter++;
    const key = `${CODE_PLACEHOLDER_PREFIX}${codeCounter}`;
    codePlaceholderMap.set(key, markdownSnippet);
    const holder = document.createElement('p');
    holder.textContent = key;
    el.replaceWith(holder);
  };

  const codeMacros = Array.from(
    clone.querySelectorAll('div.conf-macro[data-macro-name="code"], div.code.conf-macro[data-macro-name="code"]')
  );
  codeMacros.forEach((macro) => {
    const title = cleanCodeTitle(macro.querySelector('.codeHeader')?.textContent || null);
    const syntax = macro.querySelector('.syntaxhighlighter') || macro;
    const code = extractCodeFromSyntaxHighlighter(syntax);
    const language = parseMacroLanguage(macro) || inferLanguageFromCodeText(code) || inferLanguageFromElement(syntax);
    const inTableCell = !!macro.closest('td, th');
    const markdownSnippet = inTableCell ? buildTableCellCodeHtml(code, language, title) : buildFencedCodeMarkdown(code, language, title);
    replaceWithPlaceholder(macro, markdownSnippet);
  });

  const preBlocks = Array.from(clone.querySelectorAll('pre'));
  preBlocks.forEach((pre) => {
    if (pre.closest('div.conf-macro[data-macro-name="code"]')) return;
    const codeEl = pre.querySelector('code');
    const codeText = normalizeCodeText((codeEl || pre).textContent || '').trim();
    if (!codeText) return;
    const language = inferLanguageFromCodeText(codeText) || (codeEl ? inferLanguageFromElement(codeEl) : null);
    const inTableCell = !!pre.closest('td, th');
    const markdownSnippet = inTableCell ? buildTableCellCodeHtml(codeText, language, null) : buildFencedCodeMarkdown(codeText, language, null);
    replaceWithPlaceholder(pre, markdownSnippet);
  });

  if (codeCounter > 0) {
    status.update(`已格式化代码块：${codeCounter} 个`);
  }

  return { codePlaceholderMap, codeCounter };
}
