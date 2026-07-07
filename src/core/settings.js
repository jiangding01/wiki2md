/**
 * 摘墨 · 设置存储（唯一实现）
 *
 * 策略「本地为主、同步尽力」：storage.sync 单项仅 8KB，自定义规则多了会超限。
 * 写入总是落 local（必成）并尽力写 sync（跨设备）；读取 local 优先，
 * local 为空（如新设备刚同步过来）再读 sync。
 *
 * 运行环境：内容脚本 / popup / options / batch 页 / service worker（importScripts）。
 * 用 globalThis 而非 window——service worker 里没有 window。
 */

// 幂等声明：重复注入时复用首次实例
var InkSettings = globalThis.InkSettings || {

  /** 全插件唯一的默认值表 */
  DEFAULTS: {
    frontMatter: true,
    frontMatterTags: 'clippings',
    includeTitle: true,
    includeComments: true,
    commentStyle: 'both',
    highlightAnchors: true,
    imageStrategy: 'remote',
    filenameTemplate: '{title}',
    mdBullet: '-',
    mdEmphasis: '*',
    mdFence: '```',
    mdLinkStyle: 'inlined',
    complexTable: 'auto',
    keepHistory: true,
    customRules: [],
  },

  _available() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  },

  /** 原始存储值（不合并默认值）。local 优先，空则回退 sync。 */
  async read() {
    if (!this._available()) return {};
    try {
      const local = await chrome.storage.local.get('inkmarkSettings');
      if (local.inkmarkSettings) return local.inkmarkSettings;
      const sync = await chrome.storage.sync.get('inkmarkSettings');
      return sync.inkmarkSettings || {};
    } catch (e) {
      return {};
    }
  },

  /** 默认值 ← 存储 ← 调用方覆盖，导出管线的标准入口 */
  async merged(overrides) {
    return Object.assign({}, this.DEFAULTS, await this.read(), overrides || {});
  },

  /** local 必成 + sync 尽力（超配额时静默降级，本地已保存） */
  async write(settings) {
    if (!this._available()) return;
    await chrome.storage.local.set({ inkmarkSettings: settings });
    try {
      await chrome.storage.sync.set({ inkmarkSettings: settings });
    } catch (e) { /* sync 配额超限：跨设备同步降级，功能不受影响 */ }
  },

  /** 读-合并-写的部分更新（popup 即时持久化用）。
   *  内部串行化：连续快速调用（如 popup 里连点两个开关）若并发执行，
   *  后一次的 read 会拿到前一次 write 落盘前的旧值，把刚保存的偏好覆盖回去。 */
  _updateQueue: Promise.resolve(),
  update(partial) {
    const run = this._updateQueue.then(async () => {
      await this.write(Object.assign({}, await this.read(), partial));
    });
    this._updateQueue = run.catch(() => {});
    return run;
  },

  /** 清除（恢复默认） */
  async reset() {
    if (!this._available()) return;
    await chrome.storage.local.remove('inkmarkSettings');
    try {
      await chrome.storage.sync.remove('inkmarkSettings');
    } catch (e) { /* 忽略 */ }
  },
};

// 默认值表只读：merged() 是浅拷贝，customRules 数组会按引用分发给所有调用方，
// 任何一处 push/sort 都会污染全上下文的默认值——冻结后此类误用在开发期立刻显形
Object.freeze(InkSettings.DEFAULTS.customRules);
Object.freeze(InkSettings.DEFAULTS);

globalThis.InkSettings = InkSettings;
