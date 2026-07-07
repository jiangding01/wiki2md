export type DownloadedAsset = {
  sourceUrl: string;
  localPath: string;
  filename: string;
  contentType: string | null;
  byteLength: number;
};

export type FailedAsset = {
  sourceUrl: string;
  reason: string;
};

export type ExportMeta = {
  exportedAt: string;
  pageUrl: string;
  title: string;
  markdownFile: string;
  assetsDir: string;
  exporter: { name: string; version: string | null };
  images: {
    referencedImgTags: number;
    referencedSvgImages: number;
    uniqueAttempted: number;
    uniqueSucceeded: number;
    uniqueFailed: number;
  };
  codeBlocks: { formatted: number };
  anchors: { rewrittenLinks: number; injected: number };
  assets: DownloadedAsset[];
  failures: FailedAsset[];
  pipeline?: {
    steps: Array<{ name: string; durationMs: number }>;
    totalDurationMs: number;
    failedStep: string | null;
  };
};
