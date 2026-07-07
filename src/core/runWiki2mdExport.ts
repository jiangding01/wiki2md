import JSZip from 'jszip';
import { ASSETS_DIR } from './constants';
import { convertDomToMarkdown } from './markdown';
import { createChromeStatusReporter } from './status';
import type { ExportMeta } from './types';
import { detectPlatform } from '../platforms/detect';
import { extractNestedTables } from '../processors/nestedTables';
import { formatCodeBlocks } from '../processors/codeBlocks';
import { processImages } from '../processors/images';
import { normalizeTables } from '../processors/tableNormalize';
import { preprocessTableCells } from '../processors/tableCells';
import { rewriteTocAnchors } from '../processors/tocAnchors';
import { removeEmptyHeadings } from '../processors/cleanup';
import { rewriteRelativeLinksToAbsolute } from '../processors/links';
import { minimizeTableHtml } from '../processors/tableHtml';
import { forceMarkdownTables } from '../processors/forceMarkdownTables';
import { getOptions, isHostAllowed } from './options';

type PipelineStep = { name: string; durationMs: number };
type PipelineTracker = { steps: PipelineStep[]; failedStep: string | null; startedAtMs: number };

function createPipelineTracker(): PipelineTracker {
  return { steps: [], failedStep: null, startedAtMs: Date.now() };
}

async function runPipelineStep<T>(tracker: PipelineTracker, name: string, fn: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } catch (error) {
    if (!tracker.failedStep) tracker.failedStep = name;
    throw error;
  } finally {
    tracker.steps.push({ name, durationMs: Date.now() - started });
  }
}

function ensureHostAllowedOrThrow(baseUrl: string, allowlist: string[]) {
  try {
    const u = new URL(baseUrl);
    const allowed = isHostAllowed(u.hostname, allowlist);
    if (!allowed) {
      throw new Error('当前网站不在允许列表中，请在插件 Options 中添加该域名或清空允许列表以允许全部站点。');
    }
  } catch (e) {
    // If URL parsing fails, proceed; export will likely fail later with a clearer error.
    if (e instanceof Error && e.message.includes('允许列表')) throw e;
  }
}

function formatBeijingTime(d: Date) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(d);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function buildHeaderBlock(baseUrl: string, exportedAtDate: Date) {
  return `> 原文链接：${baseUrl}\n> 生成时间（北京时间）：${formatBeijingTime(exportedAtDate)}\n\n`;
}

function prependHeaderAndToc(params: {
  markdown: string;
  baseUrl: string;
  exportedAtDate: Date;
  tocMarkdown: string;
}) {
  const { markdown, baseUrl, exportedAtDate, tocMarkdown } = params;
  const headerBlock = buildHeaderBlock(baseUrl, exportedAtDate);
  if (tocMarkdown) return `${headerBlock}${tocMarkdown.trim()}\n\n${markdown.trimStart()}`;
  return `${headerBlock}${markdown.trimStart()}`;
}

function getExporterInfo() {
  try {
    const manifest = chrome.runtime.getManifest();
    return {
      name: manifest?.name || 'wiki2md',
      version: manifest?.version || null
    };
  } catch {
    return { name: 'wiki2md', version: null as string | null };
  }
}

function buildPipelineSummary(tracker: PipelineTracker): NonNullable<ExportMeta['pipeline']> {
  const totalDurationMs = Math.max(0, Date.now() - tracker.startedAtMs);
  return {
    steps: tracker.steps,
    totalDurationMs,
    failedStep: tracker.failedStep
  };
}

function triggerZipDownload(filename: string, zipBlob: Blob) {
  const downloadUrl = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(downloadUrl);
}

export async function runWiki2mdExport() {
  const w = window as any;
  const status = createChromeStatusReporter();
  const pipeline = createPipelineTracker();

  if (w.__wiki2md_exporting) {
    status.update('已有导出任务在运行，请稍候…');
    return;
  }
  w.__wiki2md_exporting = true;

  try {
    status.update('正在分析页面内容...');

    const baseUrl = window.location.href;
    const options = await runPipelineStep(pipeline, 'load-options', () => getOptions());
    await runPipelineStep(pipeline, 'validate-allowlist', () => ensureHostAllowedOrThrow(baseUrl, options.allowlist));

    const ctx = { baseUrl, document };
    const platform = await runPipelineStep(pipeline, 'detect-platform', () => detectPlatform(ctx, options));
    if (!platform) {
      throw new Error('不支持当前网站/文档类型的解析，请切换到受支持的文档页面后再试。');
    }

    const clone = await runPipelineStep(pipeline, 'clone-content', () => {
      const contentEl = platform.getContentRoot(ctx);
      const cloned = contentEl.cloneNode(true) as HTMLElement;
      platform.getSelectorsToRemove().forEach((sel) => {
        cloned.querySelectorAll(sel).forEach((el) => el.remove());
      });
      return cloned;
    });

    const rawTitle = platform.getTitle(ctx);
    const safeTitle = platform.getSafeTitle(rawTitle);
    const filenameBase = `wiki_${safeTitle || 'untitled'}`;
    const exportedAtDate = new Date();
    const exportedAt = exportedAtDate.toISOString();

    const zip = new JSZip();
    const assetsFolder = zip.folder(ASSETS_DIR);

    const pageIdToCompare = platform.getPageIdToCompare(ctx);

    const tocAnchors = await runPipelineStep(pipeline, 'rewrite-toc-anchors', () =>
      rewriteTocAnchors({ clone, baseUrl, pageIdToCompare, status })
    );

    await runPipelineStep(pipeline, 'cleanup-headings-initial', () => removeEmptyHeadings(clone));

    if (options.behaviors.rewriteRelativeLinksToAbsolute) {
      await runPipelineStep(pipeline, 'rewrite-relative-links', () => rewriteRelativeLinksToAbsolute(clone, baseUrl));
    }

    const images = await runPipelineStep(pipeline, 'process-images', () =>
      processImages({
        clone,
        baseUrl,
        assetsFolder,
        status,
        maxConcurrency: options.behaviors.imageDownloadConcurrency
      })
    );
    const codeBlocks = await runPipelineStep(pipeline, 'format-code-blocks', () => formatCodeBlocks(clone, status));

    const nestedTableMap = await runPipelineStep(pipeline, 'extract-nested-tables', () => extractNestedTables(clone));

    const forcedTables = await runPipelineStep(pipeline, 'normalize-and-force-tables', () => {
      normalizeTables(clone);
      minimizeTableHtml(clone);
      return forceMarkdownTables(clone, options.behaviors.forceMarkdownTables);
    });
    if (options.behaviors.forceMarkdownTables && forcedTables.forcedCount > 0) {
      status.update(`已强制转换 Markdown 表格：${forcedTables.forcedCount} 个（跳过 ${forcedTables.skippedCount} 个复杂表格）`);
    }

    await runPipelineStep(pipeline, 'preprocess-table-cells', () => preprocessTableCells(clone));
    await runPipelineStep(pipeline, 'cleanup-headings-final', () => removeEmptyHeadings(clone));

    status.update('正在转换为 Markdown...');
    const markdownCore = await runPipelineStep(pipeline, 'convert-dom-to-markdown', () =>
      convertDomToMarkdown({
        clone,
        nestedTableMap,
        codePlaceholderMap: codeBlocks.codePlaceholderMap,
        anchorPlaceholderMap: tocAnchors.anchorPlaceholderMap,
        tablePlaceholderMap: forcedTables.tablePlaceholderMap
      })
    );
    const markdown = await runPipelineStep(pipeline, 'compose-markdown-header', () =>
      prependHeaderAndToc({
        markdown: markdownCore,
        baseUrl,
        exportedAtDate,
        tocMarkdown: tocAnchors.tocMarkdown
      })
    );

    const exporter = await runPipelineStep(pipeline, 'read-exporter-info', () => getExporterInfo());

    const metaBase: Omit<ExportMeta, 'pipeline'> = {
      exportedAt,
      pageUrl: baseUrl,
      title: rawTitle || '',
      markdownFile: `${filenameBase}.md`,
      assetsDir: ASSETS_DIR,
      exporter,
      images: {
        referencedImgTags: images.imgElements.length,
        referencedSvgImages: images.svgImageElements.length,
        uniqueAttempted: images.uniqueAttempted,
        uniqueSucceeded: images.uniqueSucceeded,
        uniqueFailed: images.uniqueFailed
      },
      codeBlocks: {
        formatted: codeBlocks.codeCounter
      },
      anchors: {
        rewrittenLinks: tocAnchors.tocItemIndex,
        injected: tocAnchors.anchorCounter
      },
      assets: images.downloadedAssets,
      failures: images.failedAssets
    };

    await runPipelineStep(pipeline, 'write-zip-files', () => {
      const meta: ExportMeta = {
        ...metaBase,
        pipeline: buildPipelineSummary(pipeline)
      };
      zip.file(`${filenameBase}.md`, markdown);
      zip.file('meta.json', JSON.stringify(meta, null, 2));
    });

    status.update('正在生成压缩包...');
    const zipBlob = await runPipelineStep(pipeline, 'generate-zip-blob', () => zip.generateAsync({ type: 'blob' }));
    await runPipelineStep(pipeline, 'trigger-download', () => triggerZipDownload(`${filenameBase}.zip`, zipBlob));

    status.complete();
  } catch (e: any) {
    const errorMessage = e?.message || String(e);
    const withStep = pipeline.failedStep ? `[${pipeline.failedStep}] ${errorMessage}` : errorMessage;
    console.error('[wiki2md] export failed', { step: pipeline.failedStep, error: e });
    status.error(withStep);
  } finally {
    w.__wiki2md_exporting = false;
  }
}
