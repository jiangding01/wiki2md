export const ASSETS_DIR = 'assets';
export const CODE_PLACEHOLDER_PREFIX = 'CODEBLOCKPLACEHOLDER';
export const ANCHOR_PLACEHOLDER_PREFIX = 'ANCHORPLACEHOLDER';
export const TABLE_PLACEHOLDER_PREFIX = 'TABLEMDPLACEHOLDER';

// Keep concurrency modest to avoid triggering rate limits / connection resets.
export const MAX_ASSET_DOWNLOAD_CONCURRENCY = 6;

// Enable forcing Markdown tables for "simple" tables.
export const FORCE_MARKDOWN_TABLES = true;
