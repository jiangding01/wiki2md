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
   * 返回 { markdown, files: Map<path, Blob>, failed: string[] }
   */
  async localizeImages(markdown, onProgress) {
    const urls = [];
    // 匹配 ![alt](url) —— 摘墨生成的 md 图片全部是这个形式
    const re = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
    let m;
    while ((m = re.exec(markdown)) !== null) {
      if (!urls.includes(m[2])) urls.push(m[2]);
    }

    const files = new Map();
    const failed = [];
    const rename = new Map(); // 原 URL → 相对路径

    let idx = 0;
    for (const url of urls) {
      idx += 1;
      if (onProgress) onProgress(idx, urls.length);
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const ext = this._extFromType(blob.type) || this._extFromUrl(url) || 'png';
        const path = `assets/img-${String(idx).padStart(3, '0')}.${ext}`;
        files.set(path, blob);
        rename.set(url, path);
      } catch (e) {
        failed.push(url); // 抓取失败保留远程链接，不阻塞导出
      }
    }

    let out = markdown;
    for (const [url, path] of rename) {
      out = out.split(`](${url})`).join(`](${path})`);
    }
    return { markdown: out, files, failed };
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
