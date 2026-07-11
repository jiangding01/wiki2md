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

// 注入清单以 background.js 的 CONTENT_FILES 为唯一事实来源：
// 测试注入的脚本链必须与线上完全一致，否则新增适配器漏改任意一侧
// 都会造成「测试绿但线上注入失败」或「线上在跑但测试没测到」。
function loadContentFiles() {
  const src = fs.readFileSync(path.join(ROOT, 'src/background/background.js'), 'utf8');
  const m = src.match(/const CONTENT_FILES = \[([\s\S]*?)\];/);
  const files = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  if (!files.length) {
    throw new Error('无法从 src/background/background.js 提取 CONTENT_FILES 注入清单，请检查其声明形式');
  }
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) {
      throw new Error(`CONTENT_FILES 中的文件不存在：${f}`);
    }
  }
  return files;
}
const CONTENT_FILES = loadContentFiles();

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
            replies: [
              InkIR.annotation({ author: '苏澄', time: '2026-07-06', content: '同意，已修改' }),
              InkIR.annotation({ author: '陈默', content: '收到' }),
            ],
          }),
          InkIR.annotation({
            kind: 'page', author: '赵砚', time: '2026-07-06',
            content: '整体方案没问题，下周排期。',
            replies: [InkIR.annotation({ author: '林晚秋', content: '收到！' })],
          }),
        ],
      });
      return {
        withHighlight: InkMarkdown.render(ir, { frontMatter: false, includeComments: true, commentStyle: 'both' }),
        noHighlight: InkMarkdown.render(ir, { frontMatter: false, includeComments: true, commentStyle: 'both', highlightAnchors: false }),
        fmTags: InkMarkdown.render(ir, { frontMatter: true, frontMatterTags: '工作, wiki', includeComments: false }),
      };
    });
    assert(md.withHighlight.includes('==支付网关==[^1]'), '划线原文高亮 + 脚注（默认）');
    assert(md.noHighlight.includes('支付网关[^1]') && !md.noHighlight.includes('=='), '关闭高亮：仅脚注');
    assert(md.withHighlight.includes('[^1]: **陈默 · 2026-07-05**：这里建议写成'), '脚注内容完整');
    assert(/\[\^1\]: [^\n]+ {2}\n {4}↳ \*\*苏澄 · 2026-07-06\*\*：同意，已修改 {2}\n {4}↳ \*\*陈默\*\*：收到/.test(md.withHighlight),
      '脚注内回复逐行缩进展示层级（续行缩进 + 行尾双空格硬换行，缺一渲染时都会并回一行）',
      JSON.stringify(md.withHighlight.split('[^1]:')[1]));
    assert(md.withHighlight.includes('## 💬 评论'), '页面评论进附录');
    assert(md.withHighlight.includes('> > **林晚秋**'), '评论回复嵌套引用');
    assert(md.fmTags.includes('tags: [工作, wiki]'),
      '用户自定义 Front Matter 标签生效（曾因 render 漏传 opts 而失效）', md.fmTags.split('\n').find(l => l.startsWith('tags')));
  }

  /* ---------- 用例 4：文件名与选项 ---------- */
  console.log('\n[4] InkExporter · 文件名模板');
  {
    const results = await page.evaluate(() => {
      const ir = { title: 'A/B 测试: 结果?汇报', url: 'https://wiki.example.com/x' };
      return {
        tpl1: InkExporter.buildFilename('{title}', ir, 'md'),
        tpl2: InkExporter.buildFilename('{domain}-{title}-{date}', ir, 'md'),
        tpl3: InkExporter.buildFilename('{title}',
          { title: '审批页面&配置 #2 完成率100%', url: 'https://x' }, 'md'),
      };
    });
    assert(!/[\\/:*?"<>|]/.test(results.tpl1), '非法字符被净化', results.tpl1);
    assert(results.tpl2.startsWith('wiki.example.com-'), '{domain} 变量', results.tpl2);
    assert(/\d{4}-\d{2}-\d{2}/.test(results.tpl2), '{date} 变量', results.tpl2);
    assert(results.tpl3 === '审批页面＆配置 ＃2 完成率100％.md',
      '& # % 换全角（部分编辑器对链接目标里这些字符解析异常）', results.tpl3);
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

  /* ---------- 用例 8：表格边界（管道转义 / 嵌套表格 / rowspan） ---------- */
  console.log('\n[8] 表格边界 · | 转义与复杂表格降级策略');
  {
    // 默认模式：复杂表格保留为净化 HTML
    const { markdown: md } = await runPipeline(page, 'tables.html', {
      frontMatter: false, includeComments: false, complexTable: 'html',
    });
    assert(md.includes('正文里的竖线 a | b'), '正文中的 | 不被转义（作用域只在单元格）');
    assert(md.includes('<table>'), '嵌套/rowspan 表格保留为 HTML');
    assert(md.includes('<th>内层列1</th>'), '嵌套内层表格结构完整');
    assert(md.includes('rowspan="2"'), 'rowspan 属性保留');
    assert(!md.includes('内层列1内层列2甲乙'), '不再把嵌套表格压成一坨文本');
    assert(!/<table[^>]*class=/.test(md), '保留的 HTML 已净化（无 class 噪音）');

    // 扁平化模式（用户显式选择的有损降级）
    const { markdown: flat } = await runPipeline(page, 'tables.html', {
      frontMatter: false, includeComments: false, complexTable: 'flatten',
    });
    assert(!flat.includes('<table'), '扁平化模式：无 HTML 表格');
    const pipeRow = flat.split('\n').find(l => l.includes('正则'));
    assert(!!pipeRow && pipeRow.includes('A\\|B') && pipeRow.includes('`x \\|\\| y`'),
      '单元格内 |（含 code span 内）转义为 \\|', pipeRow);
    const boundaryPipes = pipeRow ? (pipeRow.replace(/\\\|/g, '').match(/\|/g) || []).length : 0;
    assert(boundaryPipes === 3, '转义后该行仍是两列结构（恰好 3 个边界 |）', `边界|数=${boundaryPipes}: ${pipeRow}`);
  }

  /* ---------- 用例 9：媒体占位 与 SPA 缓存失效 ---------- */
  console.log('\n[9] 体验加固 · 媒体占位 / SPA 缓存');
  {
    const media = await page.evaluate(() => {
      const container = document.createElement('div');
      container.innerHTML =
        '<p>视频教程：</p><iframe src="//player.bilibili.com/player.html?bvid=BV1xx" title="部署演示"></iframe>' +
        '<video><source src="/media/demo.mp4"></video>';
      const ir = InkIR.create({ title: '媒体测试', contentEl: container });
      return InkMarkdown.render(ir, { frontMatter: false, includeComments: false });
    });
    assert(media.includes('[▶️ 视频/嵌入内容：部署演示](https://player.bilibili.com/'),
      'iframe → 链接占位（带标题、协议补全）');
    assert(media.includes('demo.mp4'), 'video source → 链接占位');

    // SPA 场景：URL 变了（pushState）+ 内容变了 → 缓存必须失效
    await page.goto('file://' + path.join(ROOT, 'test/fixtures/generic-article.html'));
    for (const f of CONTENT_FILES) {
      await page.addScriptTag({ path: path.join(ROOT, f) });
    }
    const spa = await page.evaluate(async () => {
      const first = await window.__inkmark.handleAnalyze({ includeComments: false });
      document.title = 'SPA 切换后的新文章';
      document.querySelector('h1').textContent = 'SPA 切换后的新文章';
      history.pushState({}, '', location.pathname + '?spa=2');
      const second = await window.__inkmark.handleAnalyze({ includeComments: false });
      // hash 路由 SPA（docsify 等）：仅 hash 变化也必须失效缓存
      document.title = 'Hash 路由的第三篇';
      document.querySelector('h1').textContent = 'Hash 路由的第三篇';
      location.hash = '#/detail';
      const third = await window.__inkmark.handleAnalyze({ includeComments: false });
      // 导出时的标题覆盖不得污染共享缓存
      await window.__inkmark.handleExport('markdown',
        { includeComments: false, frontMatter: false, title: '一次性覆盖标题X' });
      const fourth = await window.__inkmark.handleAnalyze({ includeComments: false });
      return { first: first.title, second: second.title, third: third.title, fourth: fourth.title };
    });
    assert(spa.first !== spa.second && spa.second.includes('SPA'),
      'pushState 后缓存失效，导出新文章', JSON.stringify(spa));
    assert(spa.third.includes('Hash 路由'),
      'hash 变化也失效缓存（docsify 类 hash 路由 SPA）', spa.third);
    assert(spa.fourth === spa.third,
      '导出时的标题覆盖不污染缓存（重新分析回到真实标题）', JSON.stringify({ third: spa.third, fourth: spa.fourth }));
  }

  /* ---------- 用例 11：安全与边界（危险协议 / YAML 注入 / 并发去重 / 表头提升） ---------- */
  console.log('\n[11] 安全与边界');
  {
    const sec = await page.evaluate(async () => {
      // a) 危险协议链接被摘除
      const c1 = document.createElement('div');
      c1.innerHTML = '<a href="javascript:alert(1)">点我</a><a href="/ok">正常</a>';
      InkIR.absolutizeUrls(c1);

      // b) 复杂表格净化：事件属性与危险协议不进导出文件
      const c2 = document.createElement('div');
      c2.innerHTML = '<table onclick="evil()"><tr><th>x</th></tr>' +
        '<tr><td><table><tr><td><a href="javascript:evil()">l</a><img src="x.png" onerror="evil()"></td></tr></table></td></tr></table>';
      const htmlOut = InkMarkdown.render(
        InkIR.create({ title: 't', contentEl: c2 }),
        { frontMatter: false, includeComments: false, complexTable: 'html' });

      // c) YAML：标题换行被压平
      const c3 = document.createElement('div');
      c3.innerHTML = '<p>正文</p>';
      const fmOut = InkMarkdown.render(
        InkIR.create({ title: '第一行\n第二行', contentEl: c3 }),
        { frontMatter: true, includeComments: false });

      // d) 并发 getIR 只跑一次提取（同一 IR 对象）
      const settings = await window.__inkmark.loadSettings({ includeComments: false });
      const [ir1, ir2] = await Promise.all([
        window.__inkmark.getIR(settings), window.__inkmark.getIR(settings),
      ]);

      // e) 无表头表格：首行提升为表头 → GFM 而非原样 HTML
      const c5 = document.createElement('div');
      c5.innerHTML = '<table class="noisy"><tr><td>列甲</td><td>列乙</td></tr><tr><td>1</td><td>2</td></tr></table>';
      const flatOut = InkMarkdown.render(
        InkIR.create({ title: 't', contentEl: c5 }),
        { frontMatter: false, includeComments: false, complexTable: 'flatten' });

      // f) 代码块内容含 4+ 反引号：围栏必须比内容中最长连串更长
      const c6 = document.createElement('div');
      const pre = document.createElement('pre');
      pre.textContent = '外层文档示例\n````\n内层代码\n````';
      c6.appendChild(pre);
      const fenceOut = InkMarkdown.render(
        InkIR.create({ title: 't', contentEl: c6 }),
        { frontMatter: false, includeComments: false });

      return {
        badHref: c1.innerHTML.includes('javascript:'),
        okHref: c1.innerHTML.includes('/ok'),
        htmlOut, fmOut, flatOut, fenceOut,
        sameIR: ir1 === ir2,
      };
    });
    assert(!sec.badHref && sec.okHref, 'javascript: 链接被摘除，正常链接保留');
    assert(sec.htmlOut.includes('<table>') && !/onclick|onerror|javascript:/.test(sec.htmlOut),
      '保留的 HTML 表格无事件属性与危险协议');
    assert(sec.fmOut.includes('title: "第一行 第二行"'), 'YAML 值内换行压平');
    assert(sec.sameIR, '并发 getIR 去重（只跑一次提取）');
    assert(sec.flatOut.includes('| 列甲 | 列乙 |') && !sec.flatOut.includes('<table'),
      '无表头表格：表头提升转 GFM，不再原样输出未净化 HTML', sec.flatOut);
    assert(/`{5}\n外层文档示例/.test(sec.fenceOut),
      '代码内容含 4 个反引号时围栏加长到 5 个（此前只加长到 4 会提前闭合）', sec.fenceOut);
  }

  /* ---------- 用例 12：合并单元格网格展开（源自用户 v1 插件的实战方案） ---------- */
  console.log('\n[12] 表格网格展开 · rowspan/colspan → GFM');
  {
    const grid = await page.evaluate(() => {
      const make = () => {
        const c = document.createElement('div');
        c.innerHTML = '<table><tr><th>阶段</th><th>负责人</th></tr>' +
          '<tr><td rowspan="2">评审</td><td>甲</td></tr><tr><td>乙</td></tr>' +
          '<tr><td colspan="2">上线窗口待定</td></tr></table>';
        return c;
      };
      return {
        auto: InkMarkdown.render(InkIR.create({ title: 't', contentEl: make() }),
          { frontMatter: false, includeComments: false, complexTable: 'auto' }),
        html: InkMarkdown.render(InkIR.create({ title: 't', contentEl: make() }),
          { frontMatter: false, includeComments: false, complexTable: 'html' }),
      };
    });
    assert(!grid.auto.includes('<table'), 'auto 模式：合并单元格表格不再落 HTML');
    assert(grid.auto.includes('| 评审 | 甲 |'), 'rowspan 首格内容保留', grid.auto);
    assert(/\|\s+\|\s*乙\s*\|/.test(grid.auto), 'rowspan 跨越位补空格、行结构完整', grid.auto);
    assert(grid.auto.includes('| 上线窗口待定 |'), 'colspan 展开后内容保留');
    assert(grid.html.includes('rowspan="2"'), 'html 保守模式仍原样保留结构');
  }

  /* ---------- 用例 13：Confluence 页面树批量导出（REST mock + ZIP 解包断言） ---------- */
  console.log('\n[13] 页面树导出 · 层级镜像 / 失败报告');
  {
    await page.goto('file://' + path.join(ROOT, 'test/fixtures/confluence-page.html'));
    for (const f of CONTENT_FILES) {
      await page.addScriptTag({ path: path.join(ROOT, f) });
    }
    const tree = await page.evaluate(async () => {
      // mock 同源 REST API：128450 → 子页 200；200 → 孙页 300；300 → 无子页且正文拉取失败
      const json = (obj) => Promise.resolve({ ok: true, json: () => Promise.resolve(obj) });
      window.fetch = (url) => {
        url = String(url);
        if (url.includes('/content/128450/child/page')) return json({ results: [{ id: '200', title: '子页面A' }] });
        if (url.includes('/content/200/child/page')) return json({ results: [{ id: '300', title: '孙页面B' }, { id: '400', title: '坏页面C' }] });
        if (url.includes('/content/300/child/page') || url.includes('/content/400/child/page')) return json({ results: [] });
        if (url.includes('/content/200?expand')) return json({ title: '子页面A', body: { export_view: { value: '<p>A 的内容</p>' } } });
        if (url.includes('/content/300?expand')) return json({ title: '孙页面B', body: { export_view: {
          value: '<h2>小节</h2><p>B 的正文</p><p><img src="https://wiki.example.com/download/attachments/300/b-img.png?api=v2&amp;x=1"></p>' } } });
        if (url.includes('/content/400?expand')) return Promise.resolve({ ok: false, status: 500 });
        if (url.includes('/descendant/comment')) {
          return json({ results: [{
            id: 'tc1', type: 'comment', ancestors: [],
            body: { view: { value: '<p>树评论内容</p>' } },
            history: { createdBy: { displayName: '树评人' } },
          }] });
        }
        if (url.includes('b-img.png')) {
          return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob(['x'], { type: 'image/png' })) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      };
      // 拦截 ZIP 下载
      let captured = null;
      InkExporter.downloadBlob = (blob, filename) => { captured = { blob, filename }; };

      const res = await window.__inkmark.handleExportTree({ includeComments: false, frontMatter: false });
      if (!captured) return { res, files: [] };
      const filename = captured.filename;
      const zip = await JSZip.loadAsync(captured.blob);
      const files = Object.keys(zip.files).filter(n => !zip.files[n].dir).sort();
      const bContent = await (zip.file('支付网关重构方案/子页面A/孙页面B.md') || { async: () => '' }).async('string');
      const report = await (zip.file('导出报告.md') || { async: () => '' }).async('string');

      // 变体：打开「导出评论」——每页评论随树导出（descendant mock 供所有页命中）
      captured = null;
      const resC = await window.__inkmark.handleExportTree({ includeComments: true, frontMatter: false });
      const zipC = captured && await JSZip.loadAsync(captured.blob);
      const bWithComments = zipC
        ? await (zipC.file('支付网关重构方案/子页面A/孙页面B.md') || { async: () => '' }).async('string')
        : '';
      return { res, files, bContent, report, filename, resC, bWithComments };
    });
    assert(tree.res.ok && tree.res.pages === 3, '根页 + 子 + 孙共 3 页导出成功', JSON.stringify(tree.res));
    assert(tree.files.includes('支付网关重构方案.md') &&
           tree.files.includes('支付网关重构方案/子页面A.md') &&
           tree.files.includes('支付网关重构方案/子页面A/孙页面B.md'),
      'ZIP 目录镜像页面树层级', tree.files.join(', '));
    assert(tree.bContent.includes('## 小节') && tree.bContent.includes('B 的正文'),
      '子页面 HTML 经完整转换管线输出 Markdown');
    assert(tree.res.failed === 1 && tree.report.includes('坏页面C'),
      '失败页面进入 ZIP 内导出报告，不静默丢失', tree.report);
    assert(tree.filename.includes('页面树') && tree.filename.endsWith('.zip'), 'ZIP 文件名含标识');
    assert(tree.res.images === 1 &&
           tree.files.includes('支付网关重构方案/子页面A/assets/孙页面B/img-001.png'),
      '子页面图片进「assets/<页面名>/」分组目录（每层仅一个 assets）', tree.files.join(', '));
    assert(tree.bContent.includes('](assets/孙页面B/img-001.png)'),
      'md 内图片改为相对引用，解压即可离线查看', tree.bContent);
    assert(!tree.bContent.includes('💬'), '关闭「导出评论」时子页不含评论区');
    assert(tree.resC && tree.resC.ok &&
           tree.bWithComments.includes('## 💬 评论') && tree.bWithComments.includes('树评论内容') &&
           tree.bWithComments.includes('树评人'),
      '打开「导出评论」后子页评论随树导出', tree.bWithComments.slice(-200));
  }

  /* ---------- 用例 14：图片本地化覆盖 HTML 块 & 鉴权站点标记 ---------- */
  console.log('\n[14] 图片本地化 · HTML 块 <img> / &amp; 解码 / authImages');
  {
    await page.goto('file://' + path.join(ROOT, 'test/fixtures/confluence-page.html'));
    for (const f of CONTENT_FILES) {
      await page.addScriptTag({ path: path.join(ROOT, f) });
    }
    const img = await page.evaluate(async () => {
      const analysis = await window.__inkmark.handleAnalyze({ includeComments: false });
      const fetched = [];
      window.fetch = (url) => {
        fetched.push(String(url));
        return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob(['x'], { type: 'image/png' })) });
      };
      // markdown 形式（含带 title 的变体）+ 复杂表格直通产生的 HTML 形式（&amp; 编码）
      const md = '![a](https://w.example.com/a.png?x=1&y=2)\n\n' +
        '![t](https://w.example.com/t.png "示意图")\n\n' +
        '<table><tbody><tr><td><img src="https://w.example.com/b.png?ver=1&amp;mod=2"></td></tr></tbody></table>';
      const res = await InkExporter.localizeImages(md);
      return {
        authImages: analysis.adapter.authImages,
        out: res.markdown,
        files: Array.from(res.files.keys()),
        fetched,
      };
    });
    assert(img.authImages === true, 'Confluence 标记为鉴权图片站点（popup 据此自动切本地打包）');
    assert(img.out.includes('](assets/img-001.png)'), 'markdown 形式图片本地化');
    assert(img.out.includes('](assets/img-002.png "示意图")'),
      '带 title 的 ![alt](url "title") 也本地化且保留 title（此前正则漏网）', img.out);
    assert(img.out.includes('src="assets/img-003.png"'), 'HTML 块内 <img> 也本地化（此前漏网）');
    assert(img.fetched.includes('https://w.example.com/b.png?ver=1&mod=2'),
      'HTML 属性 &amp; 解码后抓取', img.fetched.join(', '));
    assert(img.files.length === 3, '三张图片均落入 assets/');

    // 资产目录名含空格/括号时，md 引用必须转义（CommonMark 链接目标规则）
    const esc = await page.evaluate(async () => {
      window.fetch = () => Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob(['x'], { type: 'image/png' })) });
      const res = await InkExporter.localizeImages(
        '![a](https://w.example.com/c.png)', null, 'assets/我的 页面(1)');
      return { md: res.markdown, file: Array.from(res.files.keys())[0] };
    });
    assert(esc.md.includes('](assets/我的%20页面%281%29/img-001.png)'),
      'md 引用中的空格/括号已转义', esc.md);
    assert(esc.file === 'assets/我的 页面(1)/img-001.png',
      'zip 内实际文件路径保持原样', esc.file);
  }

  /* ---------- 用例 15：重复注入无害（真实用户报错场景） ---------- */
  console.log('\n[15] 重复注入 · 全脚本链二次求值零报错');
  {
    const p2 = await browser.newPage();
    const pageErrors = [];
    p2.on('pageerror', e => pageErrors.push(e.message));
    await p2.goto('file://' + path.join(ROOT, 'test/fixtures/generic-article.html'));
    for (let round = 0; round < 2; round++) {
      for (const f of CONTENT_FILES) {
        await p2.addScriptTag({ path: path.join(ROOT, f) });
      }
    }
    const ok = await p2.evaluate(async () => {
      const res = await window.__inkmark.handleAnalyze({ includeComments: false });
      return res.ok;
    });
    assert(pageErrors.length === 0, '二次注入零页面错误（const 重声明已根除）', pageErrors.join(' | '));
    assert(ok, '重复注入后功能仍正常');
    await p2.close();
  }

  /* ---------- 用例 16：并发池语义 / 300 页硬停 / stats 跨文档类型 ---------- */
  console.log('\n[16] 并发池 · 页面树上限硬停 · stats localName');
  {
    await page.goto('file://' + path.join(ROOT, 'test/fixtures/confluence-page.html'));
    for (const f of CONTENT_FILES) {
      await page.addScriptTag({ path: path.join(ROOT, f) });
    }
    const pool = await page.evaluate(async () => {
      // 结果顺序必须与输入一致（zip 目录/图片编号的确定性依赖它），且并发不超上限
      let running = 0, peak = 0;
      const out = await InkExporter.mapPool([5, 4, 3, 2, 1], 3, async (n, i) => {
        running += 1; peak = Math.max(peak, running);
        await new Promise(r => setTimeout(r, n * 10));
        running -= 1;
        return `${i}:${n * 2}`;
      });
      return { out, peak };
    });
    assert(JSON.stringify(pool.out) === '["0:10","1:8","2:6","3:4","4:2"]',
      'mapPool 结果保持输入顺序（与完成先后无关）', JSON.stringify(pool.out));
    assert(pool.peak <= 3 && pool.peak >= 2, 'mapPool 并发数被限制在 limit 内', String(pool.peak));

    const cap = await page.evaluate(async () => {
      // 总量安全上限（maxPages）：触顶后必须硬停——不再对任何子页调用 child/page，
      // 报告只出现一条「超出上限」。用测试覆写把上限改小到 5、卷上限调大（保持单卷），
      // 直接命中硬停路径而不必构造数千页 mock。
      const cfg = window.__inkmark.__treeConfig;
      const savedMax = cfg.maxPages, savedVol = cfg.volumePages;
      cfg.maxPages = 5;         // 根 + 4 子页触顶
      cfg.volumePages = 1000;   // 卷上限拉高 → 全程单卷，与旧断言（无卷号）一致
      const json = (obj) => Promise.resolve({ ok: true, json: () => Promise.resolve(obj) });
      let childListCalls = 0;
      window.fetch = (url) => {
        url = String(url);
        if (url.includes('/child/page')) {
          childListCalls += 1;
          if (url.includes('/content/128450/')) {
            return json({ results: Array.from({ length: 350 }, (_, i) => ({ id: String(1000 + i), title: `批量子页${i}` })) });
          }
          return json({ results: [{ id: '9' + url.match(/content\/(\d+)\//)[1], title: '孙页' }] });
        }
        if (/\/content\/\d+\?expand/.test(url)) {
          const id = url.match(/content\/(\d+)\?/)[1];
          return json({ title: `批量子页${id}`, body: { export_view: { value: '<p>内容</p>' } } });
        }
        return Promise.resolve({ ok: false, status: 404 });
      };
      let captured = null;
      InkExporter.downloadBlob = (blob, filename) => { captured = { blob, filename }; };
      const res = await window.__inkmark.handleExportTree({ includeComments: false, frontMatter: false });
      const zip = await JSZip.loadAsync(captured.blob);
      const report = await (zip.file('导出报告.md') || { async: () => '' }).async('string');
      const mdCount = Object.keys(zip.files).filter(n => n.endsWith('.md') && n !== '导出报告.md').length;
      cfg.maxPages = savedMax; cfg.volumePages = savedVol; // 复原，勿泄漏到其他用例
      return { res, childListCalls, report, mdCount, filename: captured.filename };
    });
    assert(cap.res.ok && cap.res.pages === 5, '触顶总量上限：恰好导出 5 页（根 + 4 子页）', JSON.stringify(cap.res));
    assert(cap.childListCalls === 1, '触顶后不再发出任何子页面列表请求（硬停）', String(cap.childListCalls));
    assert(cap.report.split('超出').length === 2 && cap.report.includes('批量子页4'),
      '「超出上限」报告恰好一条且指向正确截断点', cap.report);
    assert(cap.mdCount === 5, 'ZIP 内 md 文件数与导出页数一致', String(cap.mdCount));
    assert(!cap.filename.includes('卷'), '单卷（卷上限内）文件名不带卷号，无回归', cap.filename);

    const xhtmlStats = await page.evaluate(() => {
      // XHTML 文档里 tagName 保持小写——stats 分类不得依赖大写比较
      const doc = new DOMParser().parseFromString(
        '<div xmlns="http://www.w3.org/1999/xhtml"><p>正文</p><img src="a.png"/><table><tr><td>x</td></tr></table><pre>code</pre></div>',
        'application/xhtml+xml');
      return InkIR.stats({ contentEl: doc.documentElement, annotations: [] });
    });
    assert(xhtmlStats.images === 1 && xhtmlStats.tables === 1 && xhtmlStats.codeBlocks === 1,
      'XHTML 文档中图片/表格/代码块分类正确', JSON.stringify(xhtmlStats));
  }

  /* ---------- 用例 21：页面树分卷打包（多卷互补 / 卷号命名 / 报告在末卷） ---------- */
  console.log('\n[21] 页面树分卷 · 多卷互补 / 卷号命名 / assets 随卷 / 末卷报告');
  {
    await page.goto('file://' + path.join(ROOT, 'test/fixtures/confluence-page.html'));
    for (const f of CONTENT_FILES) {
      await page.addScriptTag({ path: path.join(ROOT, f) });
    }
    const vol = await page.evaluate(async () => {
      // 覆写卷上限为 2：链式树 root→A→B→C→D（各页 1 子），5 页应分 3 卷。
      const cfg = window.__inkmark.__treeConfig;
      const savedMax = cfg.maxPages, savedVol = cfg.volumePages;
      cfg.volumePages = 2; cfg.maxPages = 3000;
      const json = (obj) => Promise.resolve({ ok: true, json: () => Promise.resolve(obj) });
      const chain = { '128450': '200', '200': '300', '300': '400', '400': '500', '500': null };
      const titles = { '200': '卷测子A', '300': '卷测子B', '400': '卷测子C', '500': '卷测子D' };
      window.fetch = (url) => {
        url = String(url);
        const cm = url.match(/\/content\/(\d+)\/child\/page/);
        if (cm) {
          const next = chain[cm[1]];
          return json({ results: next ? [{ id: next, title: titles[next] }] : [] });
        }
        const pm = url.match(/\/content\/(\d+)\?expand/);
        if (pm) {
          const id = pm[1];
          // 子B 带一张图片：验证 assets 随所属页面进对应卷
          const body = id === '300'
            ? '<p>B 正文</p><p><img src="https://wiki.example.com/download/attachments/300/v.png"></p>'
            : `<p>${titles[id]} 正文</p>`;
          return json({ title: titles[id], body: { export_view: { value: body } } });
        }
        if (url.includes('v.png')) {
          return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob(['x'], { type: 'image/png' })) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      };
      const dls = [];
      InkExporter.downloadBlob = (blob, filename) => dls.push({ blob, filename });
      const res = await window.__inkmark.handleExportTree({ includeComments: false, frontMatter: false });
      const zips = [];
      for (const d of dls) {
        const z = await JSZip.loadAsync(d.blob);
        zips.push({
          filename: d.filename,
          files: Object.keys(z.files).filter(n => !z.files[n].dir).sort(),
          report: z.file('导出报告.md') ? await z.file('导出报告.md').async('string') : null,
        });
      }
      cfg.maxPages = savedMax; cfg.volumePages = savedVol;
      return { res, zips };
    });
    assert(vol.res.ok && vol.res.pages === 5 && vol.res.volumes === 3,
      '5 页按每卷 2 页分为 3 卷', JSON.stringify(vol.res));
    assert(vol.zips.length === 3, '产出 3 个独立 ZIP（满卷即下载、逐卷释放内存）', String(vol.zips.length));
    assert(vol.zips.every((z, i) => z.filename.includes(`页面树-卷${i + 1}`) && z.filename.endsWith('.zip')),
      '各卷文件名带递增卷号', vol.zips.map(z => z.filename).join(', '));
    // 互补不重叠：全部 md 并集恰为 5 页且无重复
    const allMd = vol.zips.flatMap(z => z.files.filter(f => f.endsWith('.md') && f !== '导出报告.md'));
    assert(allMd.length === 5 && new Set(allMd).size === 5,
      '各卷 md 互补不重叠、并集为全树', allMd.join(', '));
    assert(vol.zips[0].files.includes('支付网关重构方案.md') &&
           vol.zips[0].files.includes('支付网关重构方案/卷测子A.md'),
      '卷1 = 根页 + 子A', vol.zips[0].files.join(', '));
    assert(vol.zips[2].files.some(f => f.endsWith('卷测子D.md')),
      '卷3 = 末页 子D', vol.zips[2].files.join(', '));
    assert(vol.zips[1].files.some(f => f.includes('assets/卷测子B/img-001.png')),
      '子B 的图片进卷2 的 assets（assets 归属随卷、卷内自洽）', vol.zips[1].files.join(', '));
    assert(!vol.zips[0].report && !vol.zips[1].report && !!vol.zips[2].report,
      '导出报告只在最后一卷', vol.zips.map(z => !!z.report).join(','));
    assert(vol.zips[2].report.includes('各卷清单') && vol.zips[2].report.includes('共 3 卷') &&
           vol.zips[2].report.includes('支付网关重构方案/卷测子A.md'),
      '末卷报告含各卷清单（覆盖此前各卷）与卷数', vol.zips[2].report);
    assert(vol.res.failed === 0, '全链路无失败项', JSON.stringify(vol.res));
  }

  /* ---------- 用例 22：页面树断点续传（预置中断状态 → 跳过已完成页、从游标继续） ---------- */
  console.log('\n[22] 页面树续传 · 跳过已完成页 / 从卷边界继续 / 完成清态');
  {
    await page.goto('file://' + path.join(ROOT, 'test/fixtures/confluence-page.html'));
    for (const f of CONTENT_FILES) {
      await page.addScriptTag({ path: path.join(ROOT, f) });
    }
    const rs = await page.evaluate(async () => {
      // e2e 环境无 chrome：注入最小的内存版 chrome.storage.local 供续传读写。
      const store = {};
      window.chrome = {
        storage: {
          local: {
            get: (k) => Promise.resolve(typeof k === 'string' ? { [k]: store[k] } : {}),
            set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
            remove: (k) => { delete store[k]; return Promise.resolve(); },
          },
        },
      };
      // 预置「卷1 已下载」的中断状态：根页 + 子A 已打包，游标停在子A（待拉其子页面）
      const preset = {
        version: 1, rootId: '128450', rootTitle: '支付网关重构方案',
        rootUrl: 'https://wiki.example.com/pages/viewpage.action?pageId=128450',
        queue: [{ id: '200', path: ['支付网关重构方案'] }],
        volumeManifest: [{ volume: 1, files: ['支付网关重构方案.md', '支付网关重构方案/卷测子A.md'] }],
        failures: [], volumesDownloaded: 1, pagesDone: 2, fetched: 2, capped: false,
        updatedAt: Date.now(),
      };
      store.inkmarkTreeResume = preset;

      const cfg = window.__inkmark.__treeConfig;
      const savedMax = cfg.maxPages, savedVol = cfg.volumePages;
      cfg.volumePages = 2; cfg.maxPages = 3000;

      // 探测：popup 据此弹「继续/重来」
      const status = await window.__inkmark.handleTreeStatus();

      const chain = { '200': '300', '300': '400', '400': '500', '500': null };
      const titles = { '200': '卷测子A', '300': '卷测子B', '400': '卷测子C', '500': '卷测子D' };
      const fetched = [];
      const json = (obj) => Promise.resolve({ ok: true, json: () => Promise.resolve(obj) });
      window.fetch = (url) => {
        url = String(url);
        fetched.push(url);
        const cm = url.match(/\/content\/(\d+)\/child\/page/);
        if (cm) {
          const next = chain[cm[1]];
          return json({ results: next ? [{ id: next, title: titles[next] }] : [] });
        }
        const pm = url.match(/\/content\/(\d+)\?expand/);
        if (pm) return json({ title: titles[pm[1]], body: { export_view: { value: `<p>${titles[pm[1]]} 正文</p>` } } });
        return Promise.resolve({ ok: false, status: 404 });
      };
      const dls = [];
      InkExporter.downloadBlob = (blob, filename) => dls.push({ blob, filename });

      const res = await window.__inkmark.handleExportTree({ includeComments: false, frontMatter: false, resume: true });
      const zips = [];
      for (const d of dls) {
        const z = await JSZip.loadAsync(d.blob);
        zips.push({ filename: d.filename, report: z.file('导出报告.md') ? await z.file('导出报告.md').async('string') : null });
      }
      cfg.maxPages = savedMax; cfg.volumePages = savedVol;
      return {
        status, res, filenames: dls.map(d => d.filename), zips,
        rootChildCalled: fetched.some(u => /\/content\/128450\/child\/page/.test(u)),
        pageA_bodyRefetched: fetched.some(u => /\/content\/200\?expand/.test(u)),
        pageA_childCalled: fetched.some(u => /\/content\/200\/child\/page/.test(u)),
        pageB_bodyFetched: fetched.some(u => /\/content\/300\?expand/.test(u)),
        cleared: store.inkmarkTreeResume === undefined,
      };
    });
    assert(rs.status.resumable && rs.status.volumesDownloaded === 1 && rs.status.pagesDone === 2,
      '状态探测：同根页面识别为可续传（已 1 卷 / 2 页）', JSON.stringify(rs.status));
    assert(rs.res.ok && rs.res.resumed === true, '本次导出标记为续传', JSON.stringify(rs.res));
    assert(!rs.rootChildCalled, '根页（已完成）不再重新拉子页面列表', String(rs.rootChildCalled));
    assert(!rs.pageA_bodyRefetched, '已打包页（子A）正文不重新拉取（跳过已完成页）', String(rs.pageA_bodyRefetched));
    assert(rs.pageA_childCalled && rs.pageB_bodyFetched,
      '从游标继续：拉子A 的子页面、抓未完成页（子B）正文', JSON.stringify({ a: rs.pageA_childCalled, b: rs.pageB_bodyFetched }));
    assert(rs.res.pages === 5 && rs.res.volumes === 3,
      '续传后总量与不中断一致：共 5 页 3 卷', JSON.stringify(rs.res));
    assert(rs.filenames.every(f => /页面树-卷[23]/.test(f)) && rs.filenames.length === 2,
      '续传只补下载卷2、卷3（卷1 不重复）', rs.filenames.join(', '));
    assert(rs.zips[1] && rs.zips[1].report && rs.zips[1].report.includes('共 3 卷') &&
           rs.zips[1].report.includes('支付网关重构方案/卷测子A.md'),
      '末卷报告跨中断汇总：含续传前卷1 的清单', rs.zips[1] && rs.zips[1].report);
    assert(rs.cleared, '正常完成后清除续传状态', String(rs.cleared));
  }

  /* ---------- 用例 17：飞书接口化采集（client_vars mock 全链路） ---------- */
  console.log('\n[17] 飞书接口精配 · block 重建 / easysync 解码 / 分页 / 回退');
  {
    await page.goto('file://' + path.join(ROOT, 'test/fixtures/feishu-docx.html'));
    for (const f of CONTENT_FILES) {
      await page.addScriptTag({ path: path.join(ROOT, f) });
    }
    const feishu = await page.evaluate(async () => {
      // easysync 文本构造器：text + 属性操作串 + 属性池
      const T = (str, ops, pool) => ({
        apool: { nextNum: Object.keys(pool || {}).length, numToAttrib: pool || {} },
        initialAttributedTexts: { attribs: { 0: ops || '' }, text: { 0: str } },
      });
      const B = (type, extra) => ({ data: Object.assign({ type, parent_id: 'FEISHUROOT123', children: [] }, extra) });

      const chunk1 = {
        id: 'FEISHUROOT123',
        has_more: true,
        cursor: '',
        next_cursors: ['CUR2'],
        block_map: {
          FEISHUROOT123: B('page', {
            text: T('接口测试文档'),
            comments: ['CMT2'], // 全文评论挂在 page 根块
            children: ['h2a', 'txt1', 'bul1', 'bul2', 'ord1', 'ord2', 'quo1', 'cod1',
              'div1', 'tab1', 'isv1', 'img1', 'todo1', 'miss1'],
          }),
          h2a: B('heading2', { text: T('第一节') }),
          // '普通'(素) + '粗体'(bold) + '码'(inlineCode) + '链接'(link)
          txt1: B('text', {
            text: T('普通粗体码链接', '+2*0+2*1+1*2+2', {
              0: ['bold', 'true'], 1: ['inlineCode', 'true'],
              2: ['link', encodeURIComponent('https://example.com/x')],
            }),
          }),
          bul1: B('bullet', { text: T('无序一'), children: ['bul1a'] }),
          bul1a: B('bullet', { text: T('嵌套项'), parent_id: 'bul1' }),
          bul2: B('bullet', { text: T('无序二') }),
        },
      };
      const chunk2 = {
        id: 'FEISHUROOT123',
        has_more: false,
        cursor: '',
        next_cursors: [],
        block_map: {
          ord1: B('ordered', { text: T('有序一'), seq: '1', comments: ['CMT1'] }),
          ord2: B('ordered', { text: T('有序二'), seq: '2' }),
          quo1: B('quote', { text: T('引用内容') }),
          cod1: B('code', { text: T('const a = 1;\nconst b = 2;'), language: 'JavaScript' }),
          div1: B('divider', {}),
          tab1: B('table', {
            columns_id: ['colA', 'colB'],
            rows_id: ['row1', 'row2', 'row3'],
            cell_set: {
              row1colA: { merge_info: { row_span: 1, col_span: 1 }, block_id: 'c11' },
              row1colB: { merge_info: { row_span: 1, col_span: 1 }, block_id: 'c12' },
              row2colA: { merge_info: { row_span: 2, col_span: 1 }, block_id: 'c21' },
              row2colB: { merge_info: { row_span: 1, col_span: 1 }, block_id: 'c22' },
              row3colA: { merge_info: { row_span: 1, col_span: 1 }, block_id: 'c31' },
              row3colB: { merge_info: { row_span: 1, col_span: 1 }, block_id: 'c32' },
            },
          }),
          c11: B('table_cell', { children: ['t11'] }), t11: B('text', { text: T('表头甲') }),
          c12: B('table_cell', { children: ['t12'] }), t12: B('text', { text: T('表头乙') }),
          c21: B('table_cell', { children: ['t21'] }), t21: B('text', { text: T('跨行格') }),
          c22: B('table_cell', { children: ['t22'] }), t22: B('text', { text: T('乙2') }),
          c31: B('table_cell', { children: [] }),
          c32: B('table_cell', { children: ['t32'] }), t32: B('text', { text: T('乙3') }),
          isv1: B('isv', {
            block_type_id: 'blk_631fefbbae02400430b8f9f4',
            data: { data: 'graph TD\n  A-->B', view: 'chart' },
          }),
          img1: B('image', { token: 'IMGTOKEN99' }),
          todo1: B('todo', { text: T('待办事项'), done: false }),
          // miss1 故意不在任何 chunk 里 → 触发「内容块缺失」告警
        },
      };

      // 评论接口（comment/batch）mock：CMT1 = 划线评论（已解决），CMT2 = 全文评论带回复
      const commentData = {
        comments: {
          CMT1: {
            comment_id: 'CMT1', is_whole: 0, finish: 1, delete_flag: 0, quote: '有序一',
            comment_list: [{ name: '甲', create_time: '2026-07-01 10:00:00', delete_flag: 0,
              content: '这里建议改一下' }],
          },
          CMT2: {
            comment_id: 'CMT2', is_whole: 1, finish: 0, delete_flag: 0, quote: '',
            comment_list: [
              { name: '乙', create_time: '2026-07-01 11:00:00', delete_flag: 0, content: '总体 ok' },
              { name: '丙', create_time: '2026-07-01 11:05:00', delete_flag: 0,
                content: '<at type="0" token="x">@蒋玲琳</at> 跟进一下 A&#x2F;B 项' },
            ],
          },
        },
      };

      const fetched = [];
      let commentBody = '';
      window.fetch = (url, init) => {
        url = String(url);
        fetched.push(url);
        if (url.includes('/space/api/comment/batch')) {
          commentBody = String((init && init.body) || '');
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 0, data: commentData }) });
        }
        if (!url.includes('/space/api/docx/pages/client_vars')) {
          return Promise.resolve({ ok: false, status: 404 });
        }
        const data = url.includes('cursor=CUR2') ? chunk2 : chunk1;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 0, data }) });
      };

      const ir = await FeishuAdapter.extract();
      const md = InkMarkdown.render(ir, { frontMatter: false, includeComments: false });
      const mdComments = InkMarkdown.render(ir, {
        frontMatter: false, includeComments: true, commentStyle: 'both',
      });

      // 接口失败 → 回退滚动采集（本页无滚动容器，直接收割可见 block）
      window.fetch = () => Promise.resolve({ ok: false, status: 403 });
      const irFallback = await FeishuAdapter.extract();

      return {
        fetched,
        badge: ir.badge,
        title: ir.title,
        siteName: ir.siteName,
        warnings: ir.warnings,
        md,
        mdComments,
        commentBody,
        annotations: ir.annotations,
        fallbackBadge: irFallback.badge,
        fallbackWarnings: irFallback.warnings,
        fallbackText: irFallback.contentEl.textContent,
      };
    });
    const cvCalls = feishu.fetched.filter(u => u.includes('client_vars'));
    assert(cvCalls.length === 2 && cvCalls[1].includes('cursor=CUR2'),
      'next_cursors 驱动分页拉取（两个 chunk）', feishu.fetched.join('\n    '));
    assert(cvCalls[0].includes('id=FEISHUROOT123') && cvCalls[0].includes('mode=7'),
      'token 来自 DOM data-record-id，参数形态与线上一致', cvCalls[0]);
    assert(feishu.badge === 'precise', '接口成功 → 徽章按次升级为 precise', feishu.badge);
    assert(feishu.title === '接口测试文档' && feishu.siteName === '飞书文档',
      '标题取自 page 根块文本', feishu.title);
    assert(feishu.md.includes('## 第一节'), 'heading2 → ##');
    assert(feishu.md.includes('**粗体**') && feishu.md.includes('`码`') &&
      feishu.md.includes('[链接](https://example.com/x)'),
      'easysync 属性解码：粗体/行内代码/链接（URL 解码）', feishu.md.split('\n').find(l => l.includes('普通')));
    assert(/无序一[\s\S]{0,24}- {1,3}嵌套项/.test(feishu.md), '子块嵌套列表正确缩进');
    assert(/1\. {1,3}有序一/.test(feishu.md) && /2\. {1,3}有序二/.test(feishu.md),
      'ordered（seq）→ 有序列表');
    assert(feishu.md.includes('> 引用内容'), 'quote → 引用块');
    assert(feishu.md.includes('```javascript\nconst a = 1;\nconst b = 2;\n```'),
      '代码块保留多行原文 + 语言标注');
    assert(/\n---\n/.test(feishu.md), 'divider → 水平线');
    assert(feishu.md.includes('| 表头甲 | 表头乙 |'), '表格 rows×cols 网格重建（首行提升表头）');
    assert(feishu.md.includes('| 跨行格 | 乙2 |') && /\|\s+\|\s*乙3\s*\|/.test(feishu.md),
      'merge_info row_span → rowspan → 网格展开补空格', feishu.md.split('\n').filter(l => l.startsWith('|')).join('\n    '));
    assert(feishu.md.includes('```mermaid\ngraph TD'), 'isv 图表块 → mermaid 围栏代码');
    assert(feishu.md.includes('/space/api/box/stream/download/all/IMGTOKEN99'),
      '图片块 → box 下载通道 URL（配合 authImages 本地打包）');
    assert(feishu.md.includes('[ ] 待办事项'), 'todo → GFM 任务列表');
    assert(feishu.warnings.some(w => w.includes('1 个内容块未在接口数据中返回')),
      '分页缺失的块计入告警，不静默丢失', feishu.warnings.join(' | '));
    assert(feishu.commentBody.includes('obj_type=22') &&
      feishu.commentBody.includes('token=FEISHUROOT123') &&
      feishu.commentBody.includes('comment_ids=CMT2') && feishu.commentBody.includes('comment_ids=CMT1'),
      '评论 id 从块的 comments 字段收集，batch 参数形态与线上一致', feishu.commentBody);
    assert(feishu.annotations.length === 2 &&
      feishu.annotations.some(a => a.kind === 'inline') &&
      feishu.annotations.find(a => a.kind === 'page').replies.length === 1,
      '划线 + 全文评论各一条，回复嵌套', JSON.stringify(feishu.annotations));
    assert(feishu.mdComments.includes('==有序一==[^1]'),
      '划线评论：quote 锚定原文 → ==高亮==[^脚注]');
    assert(feishu.mdComments.includes('[^1]: **甲 · 2026-07-01 10:00:00 · 已解决**：这里建议改一下'),
      '脚注内容完整（含「已解决」状态）', feishu.mdComments.split('\n').find(l => l.startsWith('[^1]')));
    assert(feishu.mdComments.includes('## 💬 评论') && feishu.mdComments.includes('总体 ok'),
      '全文评论进文末评论区');
    assert(feishu.mdComments.includes('@蒋玲琳 跟进一下 A/B 项') && !feishu.mdComments.includes('<at'),
      '评论富文本净化：<at> 提及转 @名字、HTML 实体解码',
      feishu.mdComments.split('\n').find(l => l.includes('蒋玲琳')));
    assert(!feishu.md.includes('[^1]') && !feishu.md.includes('💬'),
      'includeComments=false 时不织入脚注、无评论区');
    assert(feishu.fallbackBadge === undefined &&
      feishu.fallbackWarnings.some(w => w.includes('回退滚动采集')),
      '接口失败 → 回退滚动采集并明示告警', feishu.fallbackWarnings.join(' | '));
    assert(feishu.fallbackText.includes('滚动回退路径会看到的可见段落'),
      '回退路径仍能导出可见内容');
  }

  /* ---------- 用例 10：代码审读修复回归（围栏感知清洗 / 锚点编织 / 前言转义） ---------- */
  console.log('\n[10] 修复回归 · 清洗不进代码块、锚点转义感知、脚注编号避让');
  {
    const page2 = await browser.newPage();
    await page2.goto('file://' + path.join(ROOT, 'test/fixtures', 'generic-article.html'));
    for (const f of CONTENT_FILES) {
      await page2.addScriptTag({ path: path.join(ROOT, f) });
    }
    const r = await page2.evaluate(() => {
      const M = window.InkMarkdown;
      const out = {};
      // 围栏感知清洗：正文的零宽/nbsp/空行处理不得进入代码块
      out.cleaned = M._cleanupOutsideCode(
        '段一\u200b\n\n\n\n段二\u00a0x\n\n```js\nl1\n\n\n\nl4\u00a0keep\n```\n\n\n尾');
      // 编号避让：正文自带 [^3]，织入的脚注从 [^4] 开始
      out.weaveAvoid = M.weaveInlineFootnotes('自带[^3]，目标句。\n\n[^3]: 旧',
        [{ anchorText: '目标句', content: 'A', author: null, time: null, replies: [] }], {}).markdown;
      // 转义感知：锚点原文含 *，md 里被 Turndown 转义为 \*
      const w2 = M.weaveInlineFootnotes('前 foo \\*bar\\* 后',
        [{ anchorText: 'foo *bar*', content: 'B', author: null, time: null, replies: [] }], {});
      out.escHit = w2.orphans.length === 0 && w2.markdown.includes('==foo \\*bar\\*==[^1]');
      // 未闭合围栏（奇数个 ```）内不作为可锚定正文
      out.unclosed = M._indexOutsideCode('```\ncode target', 'target');
      // YAML 反斜杠最先转义
      out.fm = M.buildFrontMatter({ title: '斜杠\\', url: 'https://x.com' }, {});
      // 自定义规则选择器列表按顶层逗号拆分
      out.split = window.CustomRuleAdapter._splitSelectorList(':is(.a, .b), .c, [data-x="1,2"]');
      return out;
    });
    await page2.close();
    assert(r.cleaned.includes('l1\n\n\n\nl4\u00a0keep'),
      '清洗不进代码块（连续空行与 nbsp 原样保留）', JSON.stringify(r.cleaned));
    assert(r.cleaned.includes('段一\n\n段二 x'),
      '正文零宽/nbsp 清理与空行收敛仍生效', JSON.stringify(r.cleaned));
    assert(r.weaveAvoid.includes('==目标句==[^4]'),
      '脚注编号避让正文自带的 [^n]', r.weaveAvoid);
    assert(r.escHit, '被 Turndown 转义的锚点原文可命中（\\* 保留呈现）');
    assert(r.unclosed === -1, '未闭合围栏内不作为锚点正文');
    assert(r.fm.includes('title: "斜杠\\\\"'), 'YAML 反斜杠转义', r.fm.split('\n')[1]);
    assert(r.split.length === 3 && r.split[0] === ':is(.a, .b)' && r.split[2] === '[data-x="1,2"]',
      'removeSel 按顶层逗号拆分（:is/属性值里的逗号不拆）', JSON.stringify(r.split));
  }

  /* ---------- 用例 15：导出优化（批量图片本地化通道 / URL 括号转义） ---------- */
  console.log('\n[15] 导出优化 · localized 动作 / blobToBase64 / URL 括号');
  {
    const page3 = await browser.newPage();
    await page3.goto('file://' + path.join(ROOT, 'test/fixtures', 'generic-article.html'));
    for (const f of CONTENT_FILES) {
      await page3.addScriptTag({ path: path.join(ROOT, f) });
    }
    const r = await page3.evaluate(async () => {
      const out = {};
      // localizeImages 支持 data: URI 落盘；blobToBase64 供消息通道回传
      const loc = await InkExporter.localizeImages(
        '![a](data:image/png;base64,iVBORw0KGgo=)', null, 'assets/示例');
      const first = loc.files.entries().next().value;
      out.locPath = first && first[0];
      out.locMd = loc.markdown;
      out.b64 = first ? await InkExporter.blobToBase64(first[1]) : '';
      // localized 动作契约：markdown/images/imageFailed/oversize 齐备
      // （fixture 的图是 file:// 协议，不在收集范围内——原样保留、不计失败）
      const act = await window.__inkmark.handleExport('localized',
        { frontMatter: false, includeComments: false, assetDir: 'assets/t', keepHistory: false });
      out.action = {
        ok: act.ok,
        hasArrays: Array.isArray(act.images),
        failed: act.imageFailed,
        oversize: act.oversize,
        hasMd: typeof act.markdown === 'string' && act.markdown.length > 0,
      };
      // absolutizeUrls：URL 字面括号 → %28/%29（md 内联链接不再被 ) 提前闭合）
      const div = document.createElement('div');
      div.innerHTML = '<a href="https://x.com/a(1).html">t</a><img src="https://x.com/i(2).png">';
      InkIR.absolutizeUrls(div, 'https://x.com/');
      out.href = div.querySelector('a').getAttribute('href');
      out.src = div.querySelector('img').getAttribute('src');
      // 媒体占位（iframe 不经 absolutizeUrls）：转义在转换规则里补齐
      const td = InkMarkdown.createTurndown({});
      out.media = td.turndown('<iframe src="https://x.com/embed(v2)" title="演示"></iframe>');
      // 字面括号解码重试：%28 形态被服务端拒绝时按字面括号再抓一次
      const calls = [];
      const origFetch = window.fetch;
      window.fetch = (u) => {
        calls.push(String(u));
        if (String(u).includes('%28')) return Promise.resolve({ ok: false, status: 403 });
        return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob(['x'], { type: 'image/png' })) });
      };
      const loc2 = await InkExporter.localizeImages('![a](https://cdn.x.com/p%28n%29.png)', null, 'assets/r');
      window.fetch = origFetch;
      out.retry = { files: loc2.files.size, calls };
      return out;
    });
    await page3.close();
    assert(r.locPath === 'assets/示例/img-001.png', 'data: URI 图片落盘到指定 assetDir', r.locPath);
    assert(r.locMd.includes('](assets/示例/img-001.png)'), 'md 引用改写为相对路径', r.locMd);
    assert(/^[A-Za-z0-9+/]+=*$/.test(r.b64) && r.b64.length > 0, 'blobToBase64 输出合法 base64', r.b64);
    assert(r.action.ok && r.action.hasArrays && r.action.hasMd &&
           r.action.failed === 0 && r.action.oversize === false,
      'localized 动作契约完整（file:// 图不在收集范围，原样保留）', JSON.stringify(r.action));
    assert(r.href === 'https://x.com/a%281%29.html', 'a href 括号转义为 %28/%29', r.href);
    assert(r.src === 'https://x.com/i%282%29.png', 'img src 括号转义为 %28/%29', r.src);
    assert(r.media.includes('(https://x.com/embed%28v2%29)'),
      '媒体占位（iframe）URL 同样括号转义——不经 absolutizeUrls 的产出路径补齐', r.media);
    assert(r.retry.files === 1 && r.retry.calls.length === 2 &&
           r.retry.calls[1].includes('p(n).png'),
      '%28 形态被拒后按字面括号重试抓取成功', JSON.stringify(r.retry.calls));
  }

  /* ---------- 用例 18：预览页锚点级同步滚动 · marked token 行号映射（纯函数） ----------
     ROADMAP 远期项：双栏对照视图同步滚动从「比例映射」改为「块级锚点精确对齐」。
     核心算法在 src/preview/preview-sync.js（InkPreviewSync），不碰 DOM，可以脱离
     chrome.* 环境单独加载——这里只注入 marked + 该文件做断言。顺带验证一条
     preview.js 判定映射是否可信的前提：「token 数 == 渲染出的顶层 DOM 节点数」，
     在真实浏览器 marked.parse 输出上确实成立。 */
  console.log('\n[18] InkPreviewSync · 预览页锚点级同步滚动映射算法');
  {
    const page4 = await browser.newPage();
    await page4.goto('about:blank');
    await page4.addScriptTag({ path: path.join(ROOT, 'src/lib/marked.umd.js') });
    await page4.addScriptTag({ path: path.join(ROOT, 'src/preview/preview-sync.js') });
    const r = await page4.evaluate(() => {
      // 典型文档：front matter + 多级标题 + 长段落 + 代码块 + 表格 + 引用 + 列表
      const md = [
        '---',
        'title: "T"',
        '---',
        '',
        '# 一级标题',
        '',
        '## 二级标题',
        '',
        '这是第一段，用来验证长段落场景下的行号依旧精确对齐，不受自动换行影响，这是第一段，用来验证长段落场景下的行号依旧精确对齐，不受自动换行影响。',
        '',
        '```js',
        'const a = 1;',
        'const b = 2;',
        '```',
        '',
        '| 列1 | 列2 |',
        '| --- | --- |',
        '| a | b |',
        '',
        '> 引用块',
        '',
        '- 列表项一',
        '- 列表项二',
      ].join('\n');

      const map = InkPreviewSync.buildBlockMap(md, marked.lexer);
      const blocks = (map && map.blocks) || [];
      const out = { mapOk: !!map, blocks };

      // DOM 侧交叉验证：token 数应与真实渲染出的顶层节点数一致
      const { body } = InkPreviewSync.splitFrontMatter(md);
      const div = document.createElement('div');
      div.innerHTML = marked.parse(body, { breaks: false, gfm: true });
      out.domChildCount = div.children.length;

      // 定位 / 反定位往返：每个块自身起点应互为逆运算
      out.roundTrip = blocks.length > 0 && blocks.every((b) => {
        const loc = InkPreviewSync.locate(blocks, b.startLine);
        const back = InkPreviewSync.unlocate(blocks, loc.blockIndex, loc.fraction);
        return loc.blockIndex === b.index && back === b.startLine;
      });

      // 边界：文档最前（落在 front matter 里）/ 远超末尾的行号钳制到首尾块
      const first = blocks.length ? InkPreviewSync.locate(blocks, 1) : null;
      const last = blocks.length ? InkPreviewSync.locate(blocks, 9999) : null;
      out.clampFirst = !!first && first.blockIndex === 0 && first.fraction === 0;
      out.clampLast = !!last && last.blockIndex === blocks.length - 1 && last.fraction === 1;

      // 回退分支：空文档 / 空白文档 / lex 非函数 / lex 抛异常，一律 null
      // （调用方据此回退旧版比例同步，不能因此完全不同步）
      out.fallback = {
        empty: InkPreviewSync.buildBlockMap('', marked.lexer),
        blank: InkPreviewSync.buildBlockMap('   \n\t\n  ', marked.lexer),
        badLex: InkPreviewSync.buildBlockMap(md, 'not-a-function'),
        throws: InkPreviewSync.buildBlockMap('# x', () => { throw new Error('boom'); }),
      };
      return out;
    });
    await page4.close();

    assert(r.mapOk, '典型 markdown（多级标题/长段落/代码块/表格/引用/列表）成功建立映射');
    const types = r.blocks.map((b) => b.type);
    assert(JSON.stringify(types) ===
      JSON.stringify(['heading', 'heading', 'paragraph', 'code', 'table', 'blockquote', 'list']),
      '顶层块类型与文档结构一致（H1/H2/长段落/代码块/表格/引用/列表）', JSON.stringify(types));
    assert(r.domChildCount === r.blocks.length,
      'token 数与真实渲染出的顶层 DOM 节点数一致（preview.js 判定映射可信的前提）',
      `${r.blocks.length} vs ${r.domChildCount}`);
    assert(r.blocks[0] && r.blocks[0].startLine === 5,
      'front matter 行数正确计入偏移：H1 定位到源码第 5 行', r.blocks[0] && r.blocks[0].startLine);
    assert(r.blocks[1] && r.blocks[1].startLine === 7, 'H2 定位到第 7 行', r.blocks[1] && r.blocks[1].startLine);
    assert(r.blocks[2] && r.blocks[2].startLine === 9,
      '长段落定位到第 9 行（不受 textarea 自动换行影响，算法只看逻辑行）', r.blocks[2] && r.blocks[2].startLine);
    assert(r.blocks[3] && r.blocks[3].startLine === 11 && r.blocks[3].endLine >= 14,
      '代码块起点第 11 行、跨度覆盖到收尾围栏', JSON.stringify(r.blocks[3]));
    assert(r.blocks[4] && r.blocks[4].startLine === 16, '表格定位到第 16 行', r.blocks[4] && r.blocks[4].startLine);
    assert(r.blocks[5] && r.blocks[5].startLine === 20, '引用块定位到第 20 行', r.blocks[5] && r.blocks[5].startLine);
    assert(r.blocks[6] && r.blocks[6].startLine === 22, '列表定位到第 22 行', r.blocks[6] && r.blocks[6].startLine);
    assert(r.roundTrip, 'locate/unlocate 对每个块起点互为逆运算', JSON.stringify(r.blocks));
    assert(r.clampFirst, '文档最前的行号（落在 front matter 里）钳制到第一块开头');
    assert(r.clampLast, '远超文档末尾的行号钳制到最后一块末尾');
    assert(r.fallback.empty === null && r.fallback.blank === null &&
           r.fallback.badLex === null && r.fallback.throws === null,
      '空文档 / 空白文档 / 非法 lex / lex 抛异常均返回 null，交由调用方回退比例同步',
      JSON.stringify(r.fallback));
  }

  /* ---------- 用例 19：跨 frame 正文选优（评分纯函数） ---------- */
  console.log('\n[19] 跨 frame 选优 · InkFrameSelect 评分规则');
  {
    const pageF = await browser.newPage();
    await pageF.goto('file://' + path.join(ROOT, 'test/fixtures', 'generic-article.html'));
    await pageF.addScriptTag({ path: path.join(ROOT, 'src/core/frame-select.js') });
    const r = await pageF.evaluate(() => {
      const pick = (frames) => window.InkFrameSelect.pickContentFrame(frames);
      const top = (extra) => Object.assign({ frameId: 0, isTop: true, ok: true, adapterId: 'generic', badge: 'generic', words: 0 }, extra);
      const kid = (extra) => Object.assign({ frameId: 1, isTop: false, ok: true, adapterId: 'generic', badge: 'generic', words: 0 }, extra);
      return {
        // A: 顶层丰富 → 维持顶层，哪怕子 frame 精配命中
        topRich: pick([top({ words: 500 }), kid({ adapterId: 'confluence', badge: 'precise', words: 300 })]),
        // B: 顶层贫瘠 + 子 frame 精配命中 → 切子 frame
        childPrecise: pick([top({ words: 20 }), kid({ adapterId: 'feishu', badge: 'precise', words: 150 })]),
        // C: 顶层贫瘠 + 子 frame 字数远超（generic）→ 切子 frame
        childDominant: pick([top({ words: 30 }), kid({ words: 400 })]),
        // D: 顶层贫瘠 + 子 frame 不够显著优 → 维持顶层
        topKept: pick([top({ words: 30 }), kid({ words: 120 })]),
        // E: 顶层分析失败 + 子 frame 有内容 → 切子 frame（放宽门槛）
        topFailed: pick([top({ ok: false, words: 0 }), kid({ words: 50 })]),
        // F: 全部失败/无内容 → 维持顶层
        allEmpty: pick([top({ ok: false }), kid({ ok: false })]),
        // G: 单帧 → 维持顶层
        single: pick([top({ words: 20 })]),
      };
    });
    await pageF.close();
    assert(r.topRich.isTop && r.topRich.reason === 'top-rich',
      '顶层丰富时维持顶层（子 frame 再精配也不切）', JSON.stringify(r.topRich));
    assert(!r.childPrecise.isTop && r.childPrecise.frameId === 1 && r.childPrecise.reason === 'child-precise',
      '顶层贫瘠 + 子 frame 精配命中 → 切子 frame', JSON.stringify(r.childPrecise));
    assert(!r.childDominant.isTop && r.childDominant.frameId === 1 && r.childDominant.reason === 'child-dominant',
      '顶层贫瘠 + 子 frame 字数远超 → 切子 frame', JSON.stringify(r.childDominant));
    assert(r.topKept.isTop && r.topKept.reason === 'top-kept',
      '子 frame 不够显著优时维持顶层（不被广告 iframe 误导）', JSON.stringify(r.topKept));
    assert(!r.topFailed.isTop && r.topFailed.frameId === 1 && r.topFailed.reason === 'child-top-failed',
      '顶层分析失败时任何有内容子 frame 都优于空顶层', JSON.stringify(r.topFailed));
    assert(r.allEmpty.isTop && r.allEmpty.reason === 'all-empty',
      '全部无内容 → 兜底维持顶层', JSON.stringify(r.allEmpty));
    assert(r.single.isTop && r.single.reason === 'top-only',
      '单帧 → 维持顶层', JSON.stringify(r.single));
  }

  /* ---------- 用例 20：内嵌 iframe 正文端到端（同源子 frame 承载正文） ---------- */
  console.log('\n[20] iframe 正文 · 父页极薄 + 同源子 frame 承载正文');
  {
    const pageI = await browser.newPage();
    await pageI.goto('file://' + path.join(ROOT, 'test/fixtures', 'iframe-host.html'));
    // 模拟 background allFrames 注入：向每个 frame（顶层 + 子 frame）注入完整脚本链
    const frames = pageI.frames();
    for (const fr of frames) {
      for (const f of CONTENT_FILES) {
        await fr.addScriptTag({ path: path.join(ROOT, f) });
      }
    }
    // 各 frame 独立分析（popup 定向 INK_ANALYZE 的等价物）
    const summaries = [];
    for (const fr of frames) {
      const isTop = fr === pageI.mainFrame();
      const a = await fr.evaluate(async () => window.__inkmark.handleAnalyze({ includeComments: false }));
      summaries.push({
        frameId: isTop ? 0 : 1, isTop, ok: a.ok,
        adapterId: a.adapter.id, badge: a.adapter.badge, words: a.stats.words,
      });
    }
    // 选优在顶层上下文（frame-select.js 已随 CONTENT_FILES 注入？否——单独注入以复用同一实现）
    await pageI.mainFrame().addScriptTag({ path: path.join(ROOT, 'src/core/frame-select.js') });
    const pick = await pageI.evaluate((s) => window.InkFrameSelect.pickContentFrame(s), summaries);
    // 从选中 frame 提取 Markdown
    const chosenFrame = pick.isTop ? pageI.mainFrame() : frames.find((_, i) => i === 1);
    const md = await chosenFrame.evaluate(async () => {
      const res = await window.__inkmark.handleExport('markdown', { frontMatter: false, includeComments: false });
      return res.markdown;
    });
    await pageI.close();

    const top = summaries.find((s) => s.isTop);
    const child = summaries.find((s) => !s.isTop);
    assert(frames.length === 2, '父页 + 子 frame 共 2 个 frame', String(frames.length));
    assert(!!child && child.words > top.words, '子 frame 字数显著多于顶层空壳',
      JSON.stringify({ top: top.words, child: child && child.words }));
    assert(!pick.isTop && pick.frameId === 1, '选优结果指向承载正文的子 frame', JSON.stringify(pick));
    assert(md.includes('内嵌框架中的长文正文') && md.includes('顶层优先'),
      '从选中子 frame 提取到完整正文 Markdown', md.slice(0, 80));
  }

  await browser.close();

  /* ---------- 用例 11：注入清单一致性（防「忘记注册新文件」类回归） ----------
     CONTENT_FILES 现在单源自 background.js（见文件顶部 loadContentFiles），
     测试与线上不再有第二份手写副本可漂移；loadContentFiles 已在加载期校验
     解析成功与文件存在性。这里补一条 background 覆盖不了的断言：
     src/adapters 下每个适配器文件都必须进注入清单，防「写了新适配器忘记注册」。 */
  console.log('\n[11] 注入清单 · 适配器全部已注册（单源自 background.js）');
  {
    const adapterFiles = fs.readdirSync(path.join(ROOT, 'src/adapters')).map(f => 'src/adapters/' + f);
    const unregistered = adapterFiles.filter(f => !CONTENT_FILES.includes(f));
    assert(unregistered.length === 0, '所有适配器文件都已注册进注入清单', unregistered.join(', '));
  }

  console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`));
  process.exit(failures === 0 ? 0 : 1);
})();
