import { ANCHOR_PLACEHOLDER_PREFIX } from '../core/constants';
import type { StatusReporter } from '../core/status';
import { cssEscapeId, escapeHtml, slugifyAnchorText } from '../utils/strings';

type TocEntry = { text: string; title: string; confluenceFrag: string; localId: string };

function normalizeTocLabel(t: string) {
  return (t || '').replace(/\s+/g, ' ').trim();
}

function escapeMarkdownLinkText(text: string) {
  return (text || '').replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function extractLeadingSectionNumber(label: string) {
  const t = normalizeTocLabel(label);
  const m1 = t.match(/^(\d+(?:\.\d+)*)\s*(?:[、.．]\s*|\s+)(.+)$/);
  if (m1) return { section: m1[1], title: normalizeTocLabel(m1[2] || '') || t };
  const m2 = t.match(/^(\d+\.\d+(?:\.\d+)*)\s*(.+)$/);
  if (m2) return { section: m2[1], title: normalizeTocLabel(m2[2] || '') || t };
  return { section: null as string | null, title: t };
}

function getFragRaw(href: string) {
  const idx = href.indexOf('#');
  if (idx < 0) return null;
  const frag = href.slice(idx + 1);
  return frag || null;
}

export type TocAnchorResult = {
  tocMarkdown: string;
  anchorPlaceholderMap: Map<string, string>;
  anchorCounter: number;
  tocItemIndex: number;
};

export function rewriteTocAnchors(params: {
  clone: HTMLElement;
  baseUrl: string;
  pageIdToCompare: string | null;
  status: StatusReporter;
}): TocAnchorResult {
  const { clone, baseUrl, pageIdToCompare } = params;

  const anchorPlaceholderMap = new Map<string, string>();
  let anchorCounter = 0;

  const confluenceFragToLocalId = new Map<string, string>();
  const usedLocalIds = new Set<string>();
  const tocEntries: (TocEntry & { depth: number })[] = [];

  const isSamePageHref = (href: string) => {
    try {
      const u = new URL(href, baseUrl);
      const targetPageId = u.searchParams.get('pageId');
      return !!(pageIdToCompare && targetPageId && pageIdToCompare === targetPageId);
    } catch {
      return false;
    }
  };

  const tocLinks = Array.from(clone.querySelectorAll('a.toc-link, .toc-item-body a[href]')) as HTMLAnchorElement[];
  const tocContainer = (() => {
    const first = tocLinks[0];
    if (!first) return null;
    const macro =
      first.closest('.toc-macro') ||
      first.closest('[data-macro-name="toc"]') ||
      first.closest('.client-side-toc-macro') ||
      first.closest('.toc');
    if (macro) return macro as HTMLElement;
    let list = first.closest('ul,ol') as HTMLElement | null;
    while (list && list.parentElement && list.parentElement.tagName === 'LI') {
      const parentList = list.parentElement.closest('ul,ol') as HTMLElement | null;
      if (!parentList) break;
      list = parentList;
    }
    return list;
  })();

  const tocRootList = (() => {
    if (!tocContainer) return null;
    if (tocContainer.tagName === 'UL' || tocContainer.tagName === 'OL') return tocContainer;
    return tocContainer.querySelector('ul,ol') as HTMLElement | null;
  })();

  if (!tocContainer || !tocRootList) {
    return { tocMarkdown: '', anchorPlaceholderMap, anchorCounter, tocItemIndex: 0 };
  }

  const sectionStack: Array<string | null> = [];
  let tocItemIndex = 0;

  const makeLocalId = (text: string, section: string | null, parentSection: string | null) => {
    const { section: parsedSection, title } = extractLeadingSectionNumber(text);
    const effectiveSection = section || parsedSection || parentSection || null;
    const slugTitle = slugifyAnchorText(title || text) || 'section';
    const sectionSlug = effectiveSection ? effectiveSection.replace(/\./g, '-') : null;

    const base = sectionSlug ? `toc-${sectionSlug}-${slugTitle}` : `toc-${tocItemIndex}-${slugTitle}`;
    let localId = base;
    let suffix = 2;
    while (usedLocalIds.has(localId)) localId = `${base}-${suffix++}`;
    usedLocalIds.add(localId);
    return { localId, title, effectiveSection };
  };

  const findTocLinkInLi = (li: Element) => {
    return (
      (li.querySelector(':scope > .toc-item-body > a[href]') as HTMLAnchorElement | null) ||
      (li.querySelector(':scope > a[href]') as HTMLAnchorElement | null) ||
      (li.querySelector(':scope > span > a[href]') as HTMLAnchorElement | null) ||
      (li.querySelector('a[href]') as HTMLAnchorElement | null)
    );
  };

  const walkList = (listEl: Element, depth: number) => {
    const children = Array.from(listEl.children).filter((c) => c.tagName === 'LI') as HTMLElement[];
    for (const li of children) {
      const link = findTocLinkInLi(li);
      const nested = li.querySelector(':scope > ul, :scope > ol') as HTMLElement | null;

      const parentSection = depth > 0 ? sectionStack[depth - 1] || null : null;

      if (link) {
        const label = normalizeTocLabel(link.textContent || '');
        if (label) {
          tocItemIndex++;
          const { section } = extractLeadingSectionNumber(label);
          const { localId, title, effectiveSection } = makeLocalId(label, section, parentSection);
          const hrefRaw = (link.getAttribute('href') || '').trim();
          const fragRaw = hrefRaw ? getFragRaw(hrefRaw) : null;

          if (fragRaw) {
            confluenceFragToLocalId.set(fragRaw, localId);
            try {
              const decoded = decodeURIComponent(fragRaw);
              if (decoded && decoded !== fragRaw) confluenceFragToLocalId.set(decoded, localId);
            } catch {
              // ignore
            }
          }

          tocEntries.push({ text: label, title, confluenceFrag: fragRaw || '', localId, depth });
          sectionStack[depth] = effectiveSection;
        }
      }

      if (nested) {
        walkList(nested, depth + 1);
      }
    }
  };

  walkList(tocRootList, 0);

  const tocMarkdown = (() => {
    if (tocEntries.length === 0) return '';
    const lines = tocEntries.map((e) => {
      const indent = '    '.repeat(Math.max(0, e.depth));
      const label = escapeMarkdownLinkText(e.text);
      return `${indent}*   [${label}](#${e.localId})`;
    });
    return `${lines.join('\n')}\n`;
  })();

  // Remove the original TOC block from the DOM. We'll prepend our generated TOC to the final Markdown output.
  tocContainer.remove();

  // Rewrite other same-page links to our local ids (if mapped)
  Array.from(clone.querySelectorAll('a[href]')).forEach((a) => {
    const hrefRaw = (a.getAttribute('href') || '').trim();
    if (!hrefRaw) return;
    const fragRaw = getFragRaw(hrefRaw);
    if (!fragRaw) return;
    const isLocalHash = hrefRaw.startsWith('#');
    const isSamePage = isLocalHash || isSamePageHref(hrefRaw);
    if (!isSamePage) return;
    const mapped = confluenceFragToLocalId.get(fragRaw);
    if (!mapped) return;
    a.setAttribute('href', `#${mapped}`);
  });

  const injectedLocalIds = new Set<string>();

  const headingCandidates = Array.from(clone.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];

  const findHostForEntry = (entry: TocEntry) => {
    const normalizedText = normalizeTocLabel(entry.text);
    const normalizedTitle = normalizeTocLabel(entry.title || '');
    const { section: es, title: etTitle } = extractLeadingSectionNumber(normalizedText);

    const headingMatch = headingCandidates.find((h) => {
      const ht = normalizeTocLabel(h.textContent || '');
      if (ht === normalizedText) return true;
      if (normalizedTitle && ht === normalizedTitle) return true;
      const { section: hs, title: htTitle } = extractLeadingSectionNumber(ht);
      if (es && hs && es === hs) return true;
      if (normalizedTitle && htTitle && normalizeTocLabel(htTitle) === normalizedTitle) return true;
      if (normalizedTitle && ht.endsWith(normalizedTitle)) return true;
      return false;
    });
    if (headingMatch) return headingMatch;

    // Fallback: match by Confluence-rendered fragment id if present.
    if (entry.confluenceFrag) {
      const candidates: string[] = [entry.confluenceFrag];
      try {
        const decoded = decodeURIComponent(entry.confluenceFrag);
        if (decoded && decoded !== entry.confluenceFrag) candidates.push(decoded);
      } catch {
        // ignore
      }

      for (const cand of candidates) {
        const target = clone.querySelector(`#${cssEscapeId(cand)}`);
        if (!target) continue;
        return target.closest('h1,h2,h3,h4,h5,h6') || (target as HTMLElement);
      }
    }

    // Fallback: block-level exact match (rare, but some pages render headings as styled div/p)
    const blockCandidates = Array.from(clone.querySelectorAll('p,div,section,article')) as HTMLElement[];
    const blockMatch = blockCandidates.find((el) => {
      const bt = normalizeTocLabel(el.textContent || '');
      if (bt === normalizedText) return true;
      if (normalizedTitle && bt === normalizedTitle) return true;
      const { section: bs, title: btTitle } = extractLeadingSectionNumber(bt);
      if (es && bs && es === bs) return true;
      if (normalizedTitle && btTitle && normalizeTocLabel(btTitle) === normalizedTitle) return true;
      if (normalizedTitle && bt.includes(normalizedTitle)) return true;
      return false;
    });
    if (blockMatch) return blockMatch;

    return null;
  };

  tocEntries.forEach(({ text, title, confluenceFrag, localId }) => {
    if (injectedLocalIds.has(localId)) return;

    const host = findHostForEntry({ text, title, confluenceFrag, localId });
    if (!host || !host.parentNode) return;

    anchorCounter++;
    const key = `${ANCHOR_PLACEHOLDER_PREFIX}${anchorCounter}`;
    anchorPlaceholderMap.set(key, `<a id="${escapeHtml(localId)}"></a>`);
    const holder = document.createElement('p');
    holder.textContent = key;
    host.parentNode.insertBefore(holder, host);
    injectedLocalIds.add(localId);
  });

  if (tocItemIndex > 0) {
    params.status.update(`目录锚点处理完成：TOC ${tocItemIndex} 项，注入锚点 ${anchorCounter} 个`);
  }

  return { tocMarkdown, anchorPlaceholderMap, anchorCounter, tocItemIndex };
}
