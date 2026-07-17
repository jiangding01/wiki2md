/**
 * 摘墨 · 界面页共享工具（options / preview / batch 引入）
 * 安全敏感函数只留一份：escapeHtml 修一处即全局生效。
 */

// 幂等声明：重复引入时复用首次实例
var InkUI = globalThis.InkUI || {

  /** HTML 转义（含单引号——属性上下文也安全） */
  escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  },

  /** 页面内触发下载（锚点先入 DOM 再 click，兼容性最好；30s 后回收 URL） */
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

  /** base64 → Blob（预览页内嵌图与 ZIP 打包共用） */
  base64ToBlob(base64, mime) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], mime ? { type: mime } : undefined);
  },

  /**
   * 把渲染区内的 assets/ 相对图片引用换成内存 blob URL（预览页用）：
   * 「本地打包」策略下预览携带 base64 图片数据，扩展页没有源站登录态、
   * 远程链接必裂，本地数据才能所见即所得。
   * urlCache（Map path→objectURL，必传）跨重渲染复用；本轮不再被引用的
   * 条目会被 revoke 回收——编辑删图后 blob 不随会话泄漏。
   * 单图 base64 损坏只跳过该图，不拖垮其余。返回替换数量。
   */
  applyInlineImages(root, images, urlCache) {
    if (!images || !images.length) return 0;
    // 与 InkExporter._extFromType 是同一份 ext↔mime 对应关系的互逆两侧，
    // 新增图片格式时需两处同步
    const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                   gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };
    const byPath = new Map(images.map(i => [i.path, i]));
    const usedPaths = new Set();
    let applied = 0;
    root.querySelectorAll('img').forEach((img) => {
      let src = img.getAttribute('src') || '';
      try { src = decodeURIComponent(src); } catch (e) { /* 保留原值 */ }
      const item = byPath.get(src);
      if (!item) return;
      let url = urlCache.get(src);
      if (!url) {
        const ext = (src.match(/\.(\w+)$/) || [])[1];
        try {
          url = URL.createObjectURL(this.base64ToBlob(item.base64, MIME[ext] || 'image/png'));
        } catch (e) {
          return; // 该图数据损坏（atob 抛错等）：保留原引用，继续处理其余
        }
        urlCache.set(src, url);
      }
      usedPaths.add(src);
      img.setAttribute('src', url);
      applied += 1;
    });
    // 回收本轮不再被引用的 blob（源码编辑删掉图片引用后不泄漏）
    for (const [path, url] of Array.from(urlCache)) {
      if (!usedPaths.has(path)) {
        URL.revokeObjectURL(url);
        urlCache.delete(path);
      }
    }
    return applied;
  },
};

globalThis.InkUI = InkUI;
