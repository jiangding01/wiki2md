/**
 * 摘墨 · 输出层
 * 下载 .md、图片本地化打包 .zip。全部在页面上下文执行——
 * fetch 图片时自动携带站点登录态（Confluence/飞书的图片都需要鉴权）。
 */

const InkExporter = {

  /** 文件名净化 + 模板渲染。模板变量：{title} {domain} {date} */
  buildFilename(template, ir, ext) {
    const date = new Date();
    const pad = n => String(n).padStart(2, '0');
    const vars = {
      title: ir.title || 'untitled',
      domain: (() => { try { return new URL(ir.url).hostname; } catch (e) { return 'web'; } })(),
      date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    };
    let name = (template || '{title}').replace(/\{(title|domain|date)\}/g, (_, k) => vars[k]);
    name = name.replace(/[\\/:*?"<>|\n\r]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
    return `${name || 'untitled'}.${ext}`;
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
   * 图片本地化：抓取 markdown 中引用的图片 → assets/ 目录 → 改写为相对路径
   * 并发 4 路，单张 20s 超时；data: URI 同样落盘（fetch 原生支持）。
   * 返回 { markdown, files: Map<path, Blob>, failed: string[] }
   */
  async localizeImages(markdown, onProgress) {
    const urls = [];
    // 摘墨生成的 md 图片全部是 ![alt](url) 形式
    const re = /!\[[^\]]*\]\(((?:https?:\/\/|data:image\/)[^)\s]+)\)/g;
    let m;
    while ((m = re.exec(markdown)) !== null) {
      if (!urls.includes(m[1])) urls.push(m[1]);
    }

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
        const path = `assets/img-${String(idx + 1).padStart(3, '0')}.${ext}`;
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

    // 4 路并发的简单工作池
    const CONCURRENCY = 4;
    let cursor = 0;
    const worker = async () => {
      while (cursor < urls.length) {
        const idx = cursor++;
        await fetchOne(urls[idx], idx);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));

    let out = markdown;
    for (const [url, path] of rename) {
      out = out.split(`](${url})`).join(`](${path})`);
    }
    return { markdown: out, files, failed };
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
