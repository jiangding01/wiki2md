export type PageContext = {
  baseUrl: string;
  document: Document;
};

export type PlatformAdapter = {
  id: string;
  matches: (ctx: PageContext) => boolean;
  getContentRoot: (ctx: PageContext) => HTMLElement;
  getTitle: (ctx: PageContext) => string;
  getSafeTitle: (rawTitle: string) => string;
  getSelectorsToRemove: () => string[];
  getPageIdToCompare: (ctx: PageContext) => string | null;
};

