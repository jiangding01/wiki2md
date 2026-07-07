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
};

globalThis.InkUI = InkUI;
