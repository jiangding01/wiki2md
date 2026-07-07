import { sanitizeFilenamePart } from '../utils/strings';
import type { PageContext, PlatformAdapter } from './types';

export const confluenceAdapter: PlatformAdapter = {
  id: 'confluence',
  matches(ctx) {
    try {
      const u = new URL(ctx.baseUrl);
      return !!u.searchParams.get('pageId') || !!ctx.document.querySelector('meta[name="ajs-page-id"]');
    } catch {
      return false;
    }
  },
  getContentRoot(ctx) {
    return (
      (ctx.document.querySelector('#main-content') as HTMLElement | null) ||
      (ctx.document.querySelector('#main') as HTMLElement | null) ||
      (ctx.document.body as HTMLElement)
    );
  },
  getTitle(ctx) {
    const titleEl = ctx.document.querySelector('#title-text');
    const rawTitle = titleEl ? titleEl.textContent?.trim() : ctx.document.title;
    return (rawTitle || '页面').trim();
  },
  getSafeTitle(rawTitle) {
    // Keep stable and filesystem-safe. Chinese titles are allowed.
    return sanitizeFilenamePart(
      (rawTitle || '页面')
        .trim()
        .replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '_')
    );
  },
  getSelectorsToRemove() {
    // Keep this Confluence-specific (it removes sticky headers and UI furniture).
    return [
      'script',
      'style',
      'noscript',
      'iframe',
      'link',
      'thead.tableFloatingHeader',
      '.ia-fixed-sidebar',
      '.ia-splitter-left',
      '#sidebar',
      '#header',
      '.aui-header',
      '#footer',
      '.footer-body',
      '#comments-section',
      '.page-metadata',
      '#likes-section',
      '.page-metadata-end',
      '.plugin-tabmeta-details',
      '.page-blog-calendar',
      '.aui-nav-actions-list',
      '.hidden',
      'input[type="hidden"]'
    ];
  },
  getPageIdToCompare(ctx) {
    const currentPageId = (() => {
      try {
        return new URL(ctx.baseUrl).searchParams.get('pageId');
      } catch {
        return null;
      }
    })();

    const canonicalPageId = (() => {
      try {
        const meta = ctx.document.querySelector('meta[name="ajs-page-id"]') as HTMLMetaElement | null;
        const metaVal = meta?.content?.trim();
        if (metaVal) return metaVal;
      } catch {
        // ignore
      }
      try {
        const canonical = ctx.document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
        const href = canonical?.href;
        if (!href) return null;
        return new URL(href).searchParams.get('pageId');
      } catch {
        return null;
      }
    })();

    return currentPageId || canonicalPageId;
  }
};

