import type JSZip from 'jszip';
import { ASSETS_DIR } from '../core/constants';
import type { DownloadedAsset, FailedAsset } from '../core/types';
import type { StatusReporter } from '../core/status';
import { createConcurrencyLimiter, fetchWithRetry } from '../utils/async';
import { sha256Hex } from '../utils/crypto';
import { extFromContentType, parseContentDispositionFilename } from '../utils/http';
import { sanitizeFilenamePart } from '../utils/strings';
import {
  dataUrlToBlob,
  extractCssUrls,
  extFromUrl,
  getUrlBasename,
  isDataUrl,
  pickBestFromSrcset,
  resolveAbsoluteUrl
} from '../utils/url';

export type ImageProcessingResult = {
  imgElements: HTMLImageElement[];
  svgImageElements: Element[];
  downloadedAssets: DownloadedAsset[];
  failedAssets: FailedAsset[];
  uniqueAttempted: number;
  uniqueSucceeded: number;
  uniqueFailed: number;
};

export async function processImages(params: {
  clone: HTMLElement;
  baseUrl: string;
  assetsFolder: JSZip | null;
  status: StatusReporter;
  maxConcurrency: number;
}): Promise<ImageProcessingResult> {
  const { clone, baseUrl, assetsFolder, status, maxConcurrency } = params;

  const downloadedAssets: DownloadedAsset[] = [];
  const failedAssets: FailedAsset[] = [];
  const urlToAssetPromise = new Map<string, Promise<DownloadedAsset | null>>();

  const runAssetDownload = createConcurrencyLimiter(maxConcurrency);

  const isGenericAssetName = (name: string) => {
    const n = (name || '').trim().toLowerCase();
    if (!n) return true;
    if (/^(image|img|download|attachment|file|blob|temp)(_\d+)?$/.test(n)) return true;
    if (/^viewpage\.action$/.test(n)) return true;
    return false;
  };

  const ensureAsset = async (canonicalUrl: string): Promise<DownloadedAsset | null> => {
    const existing = urlToAssetPromise.get(canonicalUrl);
    if (existing) return existing;

    const p = runAssetDownload(async (): Promise<DownloadedAsset | null> => {
      try {
        let blob: Blob;
        let contentType: string | null = null;
        let suggestedName: string | null = null;

        if (isDataUrl(canonicalUrl)) {
          const parsed = dataUrlToBlob(canonicalUrl);
          blob = parsed.blob;
          contentType = parsed.contentType;
        } else {
          const response = await fetchWithRetry(canonicalUrl, { credentials: 'include' }, 2);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          contentType = response.headers.get('content-type');
          suggestedName = parseContentDispositionFilename(response.headers.get('content-disposition'));
          blob = await response.blob();
        }

        const ext = extFromContentType(contentType) || extFromUrl(canonicalUrl) || '.bin';

        const hash = await sha256Hex(canonicalUrl);
        const shortHash = hash.slice(0, 12);
        const urlBaseRaw = getUrlBasename(canonicalUrl);
        const urlBase = sanitizeFilenamePart(urlBaseRaw) || '';
        const suggestedBase = sanitizeFilenamePart(suggestedName || '') || '';
        const baseName = !isGenericAssetName(urlBase)
          ? urlBase
          : !isGenericAssetName(suggestedBase)
            ? suggestedBase
            : urlBase || suggestedBase || 'asset';

        const filename = `${baseName.slice(0, 48)}_${shortHash}${ext}`;
        const localPath = `${ASSETS_DIR}/${filename}`;

        assetsFolder?.file(filename, blob);

        const asset: DownloadedAsset = {
          sourceUrl: canonicalUrl,
          localPath,
          filename,
          contentType,
          byteLength: blob.size
        };
        downloadedAssets.push(asset);
        return asset;
      } catch (e: any) {
        failedAssets.push({ sourceUrl: canonicalUrl, reason: e?.message || String(e) });
        return null;
      }
    });

    urlToAssetPromise.set(canonicalUrl, p);
    return p;
  };

  // Convert inline background-image urls into explicit <img> tags to avoid losing them in Markdown conversion.
  clone.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
    const style = el.getAttribute('style') || '';
    if (!/url\(/i.test(style)) return;
    const urls = extractCssUrls(style);
    if (urls.length === 0) return;
    const parent = el.parentElement;
    if (!parent) return;
    urls.forEach((raw) => {
      const rawTrimmed = raw.trim();
      if (!rawTrimmed || rawTrimmed === 'none') return;
      if (rawTrimmed.startsWith('#')) return;
      if (/^var\(/i.test(rawTrimmed)) return;
      const img = document.createElement('img');
      img.setAttribute('data-wiki2md', 'bg');
      img.setAttribute('src', rawTrimmed);
      parent.insertBefore(img, el.nextSibling);
    });
    const cleanedStyle = style.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, '');
    el.setAttribute('style', cleanedStyle);
  });

  const imgElements = Array.from(clone.querySelectorAll('img'));
  status.update(`正在下载图片... (发现 ${imgElements.length} 个 <img>)`);

  const imgPromises = imgElements.map(async (img) => {
    const fromData = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-image-src');
    const fromSrcset = (() => {
      const srcset = img.getAttribute('srcset');
      if (!srcset) return null;
      return pickBestFromSrcset(srcset);
    })();
    const fromSrc = img.getAttribute('src');
    const rawCandidate = fromData || fromSrcset || fromSrc;
    if (!rawCandidate) return;

    const resolved = resolveAbsoluteUrl(rawCandidate, baseUrl);
    if (!resolved) return;

    const asset = await ensureAsset(resolved);
    if (asset) {
      img.setAttribute('src', asset.localPath);
      ['data-src', 'data-original', 'data-image-src', 'srcset'].forEach((attr) => img.removeAttribute(attr));
      return;
    }

    img.setAttribute('src', resolved);
    ['data-src', 'data-original', 'data-image-src'].forEach((attr) => img.removeAttribute(attr));
  });

  const svgImageElements = Array.from(clone.querySelectorAll('svg image'));
  const svgPromises = svgImageElements.map(async (imgEl) => {
    const rawHref = imgEl.getAttribute('href') || imgEl.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (!rawHref) return;
    const resolved = resolveAbsoluteUrl(rawHref, baseUrl);
    if (!resolved) return;
    const asset = await ensureAsset(resolved);
    if (asset) {
      imgEl.setAttribute('href', asset.localPath);
      imgEl.setAttributeNS('http://www.w3.org/1999/xlink', 'href', asset.localPath);
    } else {
      imgEl.setAttribute('href', resolved);
      imgEl.setAttributeNS('http://www.w3.org/1999/xlink', 'href', resolved);
    }
  });

  await Promise.all([...imgPromises, ...svgPromises]);

  const uniqueAttempted = urlToAssetPromise.size;
  const uniqueSucceeded = downloadedAssets.length;
  const uniqueFailed = failedAssets.length;
  status.update(`图片处理完成：成功 ${uniqueSucceeded}/${uniqueAttempted}，失败 ${uniqueFailed}`);

  return {
    imgElements,
    svgImageElements,
    downloadedAssets,
    failedAssets,
    uniqueAttempted,
    uniqueSucceeded,
    uniqueFailed
  };
}
