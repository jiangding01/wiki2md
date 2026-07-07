/**
 * 摘墨 · 输出层
 * 下载 .md、图片本地化打包 .zip。全部在页面上下文执行——
 * fetch 图片时自动携带站点登录态（Confluence/飞书的图片都需要鉴权）。
 */

// 幂等声明：重复注入时复用首次实例（const 重声明会抛错；裸 var 重建会清空注册表等内部状态）
var InkExporter = window.InkExporter || {

  /**
   * 文件/目录名净化的唯一实现（单页文件名与页面树目录名共用，规则永不漂移）。
   * & # % 在各类 md 渲染器的链接目标里是惯犯（实体化/锚点/百分号编码），
   * 换成全角等价字符——视觉无差别，对所有解析器都是普通文字。
   */
  sanitizeName(s, maxLen) {
    return String(s || 'untitled')
      .replace(/[\\/:*?"<>|\n\r]+/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[&#%]/g, c => ({ '&': '＆', '#': '＃', '%': '％' }[c]))
      .trim().slice(0, maxLen || 120) || 'untitled';
  },

  /** 文件名模板渲染。模板变量：{title} {domain} {date} */
  buildFilename(template, ir, ext) {
    const date = new Date();
    const pad = n => String(n).padStart(2, '0');
    const vars = {
      title: ir.title || 'untitled',
      domain: (() => { try { return new URL(ir.url).hostname; } catch (e) { return 'web'; } })(),
      date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    };
    const name = (template || '{title}').replace(/\{(title|domain|date)\}/g, (_, k) => vars[k]);
    return `${this.sanitizeName(name, 120)}.${ext}`;
  },

  /** 页面内触发下载（无需 downloads 权限） */
  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },

  downloadMarkdown(markdown, filename) {
    this.downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), filename);
  },

  /**
   * 简单并发池（唯一实现，图片抓取与页面树导出共用）：
   * 结果与输入顺序一致——zip 目录顺序、图片编号的确定性都依赖它。
   * fn 抛出的异常原样向上传播，需要「单项失败不拖垮全局」的调用方自行 try/catch。
   */
  async mapPool(items, limit, fn) {
    const out = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        out[idx] = await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  },

  /**
   * 图片本地化：抓取 markdown 中引用的图片 → assets/ 目录 → 改写为相对路径
   * 并发 4 路，单张 20s 超时；data: URI 同样落盘（fetch 原生支持）。
   * 返回 { markdown, files: Map<path, Blob>, failed: string[] }
   */
  // Markdown 形式 ![alt](url) 或 ![alt](url "title")；HTML 块中的 <img src="...">
  // （复杂表格直通会产生后者；HTML 属性里的 &amp; 需解码后抓取）
  _mdImgRe: /(!\[[^\]]*\]\()((?:https?:\/\/|data:image\/)[^)\s]+)(\s+"[^"]*")?(\))/g,
  _htmlImgRe: /(<img[^>]*?src=")((?:https?:\/\/|data:image\/)[^"]+)(")/g,

  async localizeImages(markdown, onProgress, assetDir, concurrency) {
    const urls = [];
    const seen = new Set();
    const collect = (fetchUrl) => {
      if (!seen.has(fetchUrl)) { seen.add(fetchUrl); urls.push(fetchUrl); }
    };
    for (const m of markdown.matchAll(this._mdImgRe)) collect(m[2]);
    for (const m of markdown.matchAll(this._htmlImgRe)) collect(m[2].replace(/&amp;/g, '&'));

    const files = new Map();
    const failed = [];
    const rename = new Map(); // 原 URL → 相对路径
    let done = 0;

    const fetchOne = async (url, idx) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      try {
        const res = await fetch(url, { credentials: 'include', signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const ext = this._extFromType(blob.type) || this._extFromUrl(url) || 'png';
        const path = `${assetDir || 'assets'}/img-${String(idx + 1).padStart(3, '0')}.${ext}`;
        files.set(path, blob);
        rename.set(url, path);
      } catch (e) {
        failed.push(url); // 抓取失败保留远程链接，不阻塞导出
      } finally {
        clearTimeout(timer);
        done += 1;
        if (onProgress) onProgress(done, urls.length);
      }
    };

    // 默认 4 路并发；页面树导出会传更小的值（外层已有页面级并发，
    // 总并发要压在浏览器同主机连接上限 6 以内，避免触发服务端限流）
    await this.mapPool(urls, concurrency || 4, fetchOne);

    // 单趟替换（全文只扫两遍，与图片数量无关）。
    // Markdown 链接目标里的空格/括号会破坏解析，引用写转义形式并保留 title；
    // zip 内的实际文件路径保持原样。
    let out = markdown.replace(this._mdImgRe, (all, pre, url, title, close) => {
      const path = rename.get(url);
      return path ? pre + this._mdPathEscape(path) + (title || '') + close : all;
    });
    out = out.replace(this._htmlImgRe, (all, pre, encUrl, close) => {
      const path = rename.get(encUrl.replace(/&amp;/g, '&'));
      return path ? pre + path + close : all;
    });
    return { markdown: out, files, failed };
  },

  /** CommonMark 链接目标转义：处理会破坏解析/被误解码的字符，保持 CJK 可读。% 必须最先转义。 */
  _mdPathEscape(path) {
    return path.replace(/%/g, '%25').replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  },

  /**
   * 导出历史：记录到 chrome.storage.local。
   * 单条正文上限 300KB，最多 30 条且全库正文总量约 3MB——超限的旧条目只留元信息。
   */
  async recordHistory(ir, markdown, filename, action) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    try {
      const entry = {
        ts: Date.now(),
        title: ir.title,
        url: ir.url,
        adapter: (ir._adapter && ir._adapter.name) || '通用模式',
        filename,
        action,
        chars: markdown.length,
        markdown: markdown.length <= 300_000 ? markdown : null,
      };
      const { inkmarkHistory = [] } = await chrome.storage.local.get('inkmarkHistory');
      const list = [entry].concat(inkmarkHistory).slice(0, 30);
      let budget = 3_000_000;
      for (const e of list) {
        if (e.markdown) {
          budget -= e.markdown.length;
          if (budget < 0) e.markdown = null;
        }
      }
      await chrome.storage.local.set({ inkmarkHistory: list });
    } catch (e) {
      console.warn('[inkmark] history record failed:', e); // 历史失败绝不阻塞导出
    }
  },

  /** md + 本地化图片 → zip 并下载 */
  async downloadZip(markdown, ir, filenameTemplate, onProgress) {
    const { markdown: localMd, files, failed } = await this.localizeImages(markdown, onProgress);
    const zip = new JSZip();
    const baseName = this.buildFilename(filenameTemplate, ir, 'md').replace(/\.md$/, '');
    zip.file(`${baseName}/index.md`, localMd);
    for (const [path, blob] of files) {
      zip.file(`${baseName}/${path}`, blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    this.downloadBlob(zipBlob, `${baseName}.zip`);
    return { imageCount: files.size, failedCount: failed.length };
  },

  _extFromType(mime) {
    const map = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
      'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
    };
    return map[(mime || '').split(';')[0]] || null;
  },

  _extFromUrl(url) {
    const m = url.match(/\.(png|jpe?g|gif|webp|svg|bmp)(\?|$)/i);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : null;
  },
};

window.InkExporter = InkExporter;
