/**
 * 摘墨 · 端到端管线测试
 *
 * 在真实 Chromium 中加载 fixture 页面，注入完整脚本链，
 * 跑「适配器 → IR → Markdown」全流程并断言输出。
 *
 * 运行：npm install playwright 后 node test/e2e.js
 * （若使用预装浏览器，设置 CHROMIUM_PATH 环境变量）
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

const CONTENT_FILES = [
  'src/lib/readability.js',
  'src/lib/turndown.js',
  'src/lib/turndown-plugin-gfm.js',
  'src/lib/jszip.min.js',
  'src/core/ir.js',
  'src/core/markdown.js',
  'src/adapters/registry.js',
  'src/adapters/generic.js',
  'src/adapters/custom.js',
  'src/adapters/confluence.js',
  'src/adapters/feishu.js',
  'src/adapters/cn-sites.js',
  'src/adapters/intl-sites.js',
  'src/core/exporter.js',
  'src/core/pipeline.js',
];

let failures = 0;

function assert(cond, label, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? `\n    ${detail}` : ''}`);
  }
}

async function runPipeline(page, fixture, options) {
  await page.goto('file://' + path.join(ROOT, 'test/fixtures', fixture));
  for (const f of CONTENT_FILES) {
    await page.addScriptTag({ path: path.join(ROOT, f) });
  }
  return page.evaluate(async (opts) => {
    const res = await window.__inkmark.handleExport('markdown', opts);
    const analysis = await window.__inkmark.handleAnalyze(opts);
    return { markdown: res.markdown, analysis };
  }, options);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage();

  /* ---------- 用例 1：通用适配器 ---------- */
  console.log('\n[1] GenericAdapter · 普通文章页');
  {
    const { markdown: md, analysis } = await runPipeline(page, 'generic-article.html', {
      frontMatter: true, includeComments: false,
    });
    assert(analysis.adapter.id === 'generic', '命中通用适配器', analysis.adapter.id);
    assert(md.startsWith('---\n'), '包含 Front Matter');
    assert(md.includes('title: "深入理解虚拟滚动'), 'Front Matter 标题正确');
    assert(md.includes('author: "苏澄"'), 'Front Matter 作者正确');
    assert(/```javascript\nfunction visibleRange/.test(md), '代码块语言识别 (javascript)');
    assert(md.includes('| 方案 |'), 'GFM 表格');
    assert(md.includes('==只渲染视口附近的元素=='), '<mark> → ==高亮==');
    assert(md.includes('![虚拟滚动示意图](file://'), '懒加载图片修复 + URL 绝对化');
    assert(md.includes('*图 1：视口窗口随滚动平移*'), 'figcaption 转说明文字');
    assert(!md.includes('归档') && !md.includes('RSS'), '导航/页脚噪音被剔除');
  }

  /* ---------- 用例 2：Confluence 适配器 ---------- */
  console.log('\n[2] ConfluenceAdapter · wiki 页面');
  {
    const { markdown: md, analysis } = await runPipeline(page, 'confluence-page.html', {
      frontMatter: true, includeComments: false,
    });
    assert(analysis.adapter.id === 'confluence', '命中 Confluence 适配器', analysis.adapter.id);
    assert(md.includes('# 支付网关重构方案'), '标题来自 #title-text');
    assert(/```java\npublic Route resolve/.test(md), '代码宏 → fenced code (java)');
    assert(md.includes('> 🚫 **资金安全**'), 'warning 面板 → callout 引用块');
    assert(md.includes('| 指标 |'), 'Confluence 表格 → GFM 表格');
    assert(md.includes('/wiki/download/attachments/128450/arch.png'), '缩略图 → 原图 URL');
    assert(!md.includes('导航栏'), '页面 chrome 被剔除');
  }

  /* ---------- 用例 3：评论渲染（IR 层单测） ---------- */
  console.log('\n[3] InkMarkdown · 评论脚注 + 附录');
  {
    const md = await page.evaluate(() => {
      const container = document.createElement('div');
      container.innerHTML = '<p>本方案评审新一代支付网关的技术选型。</p>';
      const ir = InkIR.create({
        title: '评论测试',
        contentEl: container,
        annotations: [
          InkIR.annotation({
            kind: 'inline', anchorText: '支付网关', author: '陈默',
            time: '2026-07-05', content: '这里建议写成「统一收单网关」',
          }),
          InkIR.annotation({
            kind: 'page', author: '赵砚', time: '2026-07-06',
            content: '整体方案没问题，下周排期。',
            replies: [InkIR.annotation({ author: '林晚秋', content: '收到！' })],
          }),
        ],
      });
      return InkMarkdown.render(ir, { frontMatter: false, includeComments: true, commentStyle: 'both' });
    });
    assert(md.includes('支付网关[^1]'), '划线评论锚定为脚注');
    assert(md.includes('[^1]: **陈默 · 2026-07-05**：这里建议写成'), '脚注内容完整');
    assert(md.includes('## 💬 评论'), '页面评论进附录');
    assert(md.includes('> > **林晚秋**'), '评论回复嵌套引用');
  }

  /* ---------- 用例 4：文件名与选项 ---------- */
  console.log('\n[4] InkExporter · 文件名模板');
  {
    const results = await page.evaluate(() => {
      const ir = { title: 'A/B 测试: 结果?汇报', url: 'https://wiki.example.com/x' };
      return {
        tpl1: InkExporter.buildFilename('{title}', ir, 'md'),
        tpl2: InkExporter.buildFilename('{domain}-{title}-{date}', ir, 'md'),
      };
    });
    assert(!/[\\/:*?"<>|]/.test(results.tpl1), '非法字符被净化', results.tpl1);
    assert(results.tpl2.startsWith('wiki.example.com-'), '{domain} 变量', results.tpl2);
    assert(/\d{4}-\d{2}-\d{2}/.test(results.tpl2), '{date} 变量', results.tpl2);
  }

  /* ---------- 用例 5：边界用例（表格扁平化 / 公式还原 / 零宽字符） ---------- */
  console.log('\n[5] 边界用例 · 表格 / 公式 / 不可见字符');
  {
    const { markdown: md } = await runPipeline(page, 'edge-cases.html', {
      frontMatter: false, includeComments: false,
    });
    const tableLine = md.split('\n').find(l => l.includes('方案A'));
    assert(!!tableLine && tableLine.includes('第一段说明') && tableLine.includes('• 要点一'),
      '单元格块级元素扁平化为单行', tableLine);
    assert(tableLine && tableLine.includes('`npm install npm run build`'),
      '单元格内代码块 → 行内 code', tableLine);
    assert(md.includes('$E=mc^2$'), 'KaTeX 还原为 $LaTeX$');
    assert(md.includes('$\\alpha + \\beta$'), 'MathJax v2 还原为 $LaTeX$');
    assert(!md.includes('​') && !md.includes('﻿'), '零宽字符 / BOM 被清理');
  }

  /* ---------- 用例 6：Markdown 风格设置 ---------- */
  console.log('\n[6] Markdown 风格 · 用户偏好生效');
  {
    const { markdown: md } = await runPipeline(page, 'generic-article.html', {
      frontMatter: false, includeComments: false,
      mdBullet: '*', mdEmphasis: '_', mdFence: '~~~',
    });
    assert(/^\*   .*测量缓存/m.test(md) || /^\* .*测量缓存/m.test(md), '列表符号切换为 *');
    assert(md.includes('_测量缓存_'), '强调符号切换为 _');
    assert(/~~~javascript\n/.test(md), '代码围栏切换为 ~~~');
  }

  /* ---------- 用例 7：自定义站点规则 ---------- */
  console.log('\n[7] CustomRuleAdapter · 用户规则优先');
  {
    await page.goto('file://' + path.join(ROOT, 'test/fixtures/edge-cases.html'));
    for (const f of CONTENT_FILES) {
      await page.addScriptTag({ path: path.join(ROOT, f) });
    }
    const result = await page.evaluate(async () => {
      const settings = await window.__inkmark.loadSettings({
        frontMatter: false, includeComments: false,
        customRules: [{
          name: '测试规则', match: 'edge-cases', contentSel: '#custom-zone',
          titleSel: '#the-title', removeSel: 'h2',
        }],
      });
      const ir = await window.__inkmark.getIR(settings);
      return { adapter: ir._adapter, title: ir.title, hasH2: !!ir.contentEl.querySelector('h2') };
    });
    assert(result.adapter.id === 'custom', '命中自定义规则适配器', result.adapter.id);
    assert(result.adapter.name === '测试规则', '徽章显示规则名');
    assert(result.title === '边界用例合集', '标题选择器生效');
    assert(!result.hasH2, '剔除选择器生效（h2 被移除）');
  }

  await browser.close();

  console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`));
  process.exit(failures === 0 ? 0 : 1);
})();
