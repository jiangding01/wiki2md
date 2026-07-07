/**
 * 摘墨 · 用户自定义规则适配器
 *
 * 用户在设置页维护规则（无需写代码），命中的规则优先级高于所有内置适配器——
 * 内置适配器效果不佳时，用户可以自行覆盖。
 *
 * 规则结构（存于 settings.customRules，pipeline 注入 window.__inkCustomRules）：
 * {
 *   name:       string   规则名（popup 徽章显示）
 *   match:      string   URL 包含此子串即命中
 *   contentSel: string   正文 CSS 选择器
 *   titleSel:   string   标题选择器（可空，默认 document.title）
 *   removeSel:  string   额外剔除的选择器，逗号分隔（可空）
 * }
 */

const CustomRuleAdapter = {
  id: 'custom',
  name: '自定义规则',
  badge: 'custom',
  _rule: null,

  match(loc) {
    const rules = window.__inkCustomRules || [];
    this._rule = rules.find(r =>
      r && r.match && r.contentSel && loc.href.includes(r.match)
    ) || null;
    if (this._rule) this.name = this._rule.name || '自定义规则';
    return !!this._rule;
  },

  async extract() {
    const rule = this._rule;
    const source = document.querySelector(rule.contentSel);
    if (!source) {
      // 选择器失配：降级到通用模式并告知用户，绝不空手而归
      const ir = await GenericAdapter.extract();
      ir.warnings.push(`自定义规则「${rule.name || rule.match}」的正文选择器（${rule.contentSel}）未命中，已回退通用模式。`);
      return ir;
    }

    const container = document.createElement('div');
    container.appendChild(InkIR.detach(source));
    InkIR.removeNoise(container, (rule.removeSel || '').split(',').map(s => s.trim()).filter(Boolean));
    InkIR.fixLazyImages(container);
    InkIR.absolutizeUrls(container);

    let title = document.title;
    if (rule.titleSel) {
      const t = document.querySelector(rule.titleSel);
      if (t && t.textContent.trim()) title = t.textContent.trim();
    }

    return InkIR.create({ title, contentEl: container });
  },
};

window.CustomRuleAdapter = CustomRuleAdapter;
