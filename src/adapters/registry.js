/**
 * 摘墨 · 适配器注册表
 *
 * 适配器接口：
 * {
 *   id:      string        唯一标识
 *   name:    string        展示名（popup 徽章）
 *   badge:   'precise' | 'experimental' | 'generic'
 *   match(location, document): boolean    是否命中当前页面
 *   extract(options): Promise<IR>         提取为中间表示
 * }
 *
 * 匹配顺序 = 注册顺序；GenericAdapter 永远兜底，必须最后注册。
 */

const InkAdapters = {
  _list: [],

  register(adapter) {
    this._list.push(adapter);
  },

  /** 返回第一个命中的适配器（Generic 兜底，永不为空） */
  resolve() {
    for (const a of this._list) {
      try {
        if (a.match(location, document)) return a;
      } catch (e) {
        console.warn('[inkmark] adapter match error:', a.id, e);
      }
    }
    return this._list[this._list.length - 1]; // GenericAdapter
  },

  all() {
    return this._list.slice();
  },
};

window.InkAdapters = InkAdapters;
