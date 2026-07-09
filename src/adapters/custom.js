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

// 幂等声明：重复注入时复用首次实例（const 重声明会抛错；裸 var 重建会清空注册表等内部状态）
var CustomRuleAdapter = window.CustomRuleAdapter || {
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

    const container = InkIR.buildContainer(source, this._splitSelectorList(rule.removeSel));

    return InkIR.create({
      title: InkIR.pickTitle(rule.titleSel || null),
      contentEl: container,
    });
  },

  /**
   * 按「顶层逗号」拆分选择器列表：:is(a, b)、[attr="x,y"] 里的逗号不拆。
   * 拆开只为单条失效不拖累其余（removeNoise 对每条各自 try/catch）；
   * 朴素 split(',') 会把函数式伪类拆成两个非法选择器，整条规则的剔除全部失效。
   */
  _splitSelectorList(s) {
    const out = [];
    let cur = '';
    let depth = 0;
    let quote = null;
    for (const ch of String(s || '')) {
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(x => x.trim()).filter(Boolean);
  },
};

window.CustomRuleAdapter = CustomRuleAdapter;
