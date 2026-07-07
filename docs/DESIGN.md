# 摘墨 Inkmark · 完整方案设计

> 从「仅支持 Confluence 正文导出的 wiki2md」到「任意网页 → Markdown 的通用摘录工具」。
> 本文档是 v2.0 的设计蓝本，也是后续迭代的路线图。

---

## 1. 产品定位

**一句话**：把你正在读的任何网页——文档、文章、评论——变成一份干净、可归档、Obsidian 友好的 Markdown。

**三层能力模型**（同时也是架构分层的依据）：

| 层 | 能力 | 覆盖面 | 质量 |
| --- | --- | --- | --- |
| 兜底层 | 任意网页正文提取（Readability） | 100% 网页 | 良 |
| 精配层 | 站点适配器（Confluence / 飞书 / 公众号 / 知乎 / 掘金…） | 高频平台 | 优 |
| 增强层 | 评论导出（划线→脚注、页评→附录）、图片打包、元数据 | 精配平台逐步覆盖 | 优 |

**设计原则**：

1. **兜底优先**——"支持所有网页"不是遥远目标，而是架构默认行为；精配只是在兜底之上的增强。
2. **绝不静默丢数据**——canvas 表格导不出就插占位说明，评论拉不到就在 UI 上告警。
3. **平台差异止步于适配器**——Markdown 转换全插件只有一份，规则统一维护。

---

## 2. 架构总览

```
┌───────────────────────────────────────────────────────────┐
│ 适配器层  src/adapters/                                     │
│   registry.js   按 URL/DOM 特征匹配，顺序即优先级              │
│   confluence.js 正文规范化 + REST API 拉取页评/划线评论         │
│   feishu.js     虚拟滚动采集（实验性）                         │
│   cn-sites.js   微信公众号 / 知乎 / 掘金                      │
│   generic.js    Readability 兜底（永远最后注册）               │
│        每个适配器只产出一件东西：IR（中间表示）                  │
├───────────────────────────────────────────────────────────┤
│ 中间表示  src/core/ir.js                                    │
│   { title, byline, siteName, url, publishedTime,           │
│     contentEl(规范化DOM), annotations[], warnings[] }       │
│   annotation = { kind: inline|page, anchorText,            │
│                  author, time, content, replies[] }        │
├───────────────────────────────────────────────────────────┤
│ 转换层    src/core/markdown.js  （全局唯一的 IR→md 出口）      │
│   Turndown + GFM + 自定义规则：                              │
│   代码块语言 / callout引用块 / ==高亮== / figure / 脚注编织     │
├───────────────────────────────────────────────────────────┤
│ 输出层    src/core/exporter.js                              │
│   下载.md / 复制 / 图片本地化打包.zip / 文件名模板              │
├───────────────────────────────────────────────────────────┤
│ 编排      src/core/pipeline.js（内容脚本入口，消息驱动）        │
│ 驱动      popup / 右键菜单 / Alt+Shift+M / options           │
└───────────────────────────────────────────────────────────┘
```

### 2.1 关键决策与理由

**为什么整条管线跑在页面上下文（content script），而不是 service worker？**

- Readability / Turndown 依赖 DOM，MV3 的 service worker 里没有 DOM；
- 抓取需要登录态的图片（Confluence 附件、飞书图床）时，页面内 `fetch` 自动携带 cookie；
- Confluence 评论 REST API 是同源请求，天然免鉴权配置。
- service worker 只做三件事：按需注入脚本、右键菜单、快捷键。

**为什么用 activeTab + scripting 按需注入，而不声明 `<all_urls>` content_scripts？**

- 权限最小化：安装时不索要"读取所有网站数据"，商店审核友好、用户信任度高；
- 用户点击（popup / 右键 / 快捷键）即时授权当前标签页，体验无差异。

**为什么评论是 IR 里的独立通道（annotations），而不混进正文 DOM？**

- 呈现方式是用户偏好（脚注 / 附录 / 两者），必须在转换期决定而不是提取期；
- 划线评论需要"锚点编织"：在转换后的 Markdown 里定位原文片段、插入 `[^n]`，
  找不到锚点的自动降级进文末附录——保证数据不丢。

**防重复注入与提取缓存**：`window.__INKMARK_LOADED__` 防止多次注入；
analyze 与 export 之间缓存 IR（飞书滚动采集成本高，不能跑两遍）。

### 2.2 消息协议

| 消息 | 方向 | 说明 |
| --- | --- | --- |
| `INK_INJECT` | popup → SW | 请求向指定 tab 注入脚本链 |
| `INK_ANALYZE` | popup → page | 返回适配器信息、标题、字数/图/表/评论统计、告警 |
| `INK_EXPORT` (action: markdown/download/zip) | popup → page | 取文本 / 页内下载 / 图片打包下载 |
| `INK_EXPORT_SELECTION` | SW → page | 右键菜单：仅导出选中内容 |

---

## 3. 各平台适配策略

| 平台 | 难点 | 策略 | 状态 |
| --- | --- | --- | --- |
| Confluence | 代码宏/信息面板私有结构；评论在 API 里 | DOM 规范化 + REST API（`child/comment` expand `inlineProperties` 拿划线原文） | ✅ 精配 |
| 通用网页 | 正文识别 | Readability，失败时整页强清洗降级 | ✅ 兜底 |
| 微信公众号 | 全量 data-src 懒加载 | `#js_content` + 懒加载修复 | ✅ 精配 |
| 知乎 | 公式是图片 | RichText 容器 + `img[eeimg]` alt 还原为 `$LaTeX$` | ✅ 精配 |
| 掘金 | 代码块装饰控件 | `.markdown-body` + 控件剔除 | ✅ 精配 |
| 飞书文档 | **虚拟滚动**：DOM 只有视口附近的 block | 自动滚动 + `data-block-id` 去重采集；canvas 表格插占位告警 | 🧪 实验性 |
| 腾讯文档 | 正文 canvas 化/深度混淆 | 需走内部导出接口（同源带 session），下阶段专项 | 🗓 规划中 |

**飞书的取舍说明**：更稳的方案是调用飞书前端自己的 block 数据接口，但接口无公开契约、
版本波动大；v2.0 先落地"滚动采集"这一不依赖接口的通用方案并明确标注实验性，
接口方案作为 v2.1 专项。

---

## 4. 评论导出设计

```
划线评论 (kind=inline, 有 anchorText)
  └─ commentStyle=footnote/both：在 md 正文中找到锚点原文 → 追加 [^n]
       └─ 找不到锚点（原文被编辑过）→ 降级进文末附录，附「📌 划线：…」上下文
页面评论 (kind=page)
  └─ 统一进文末「## 💬 评论」区，回复用嵌套引用（> >）表达
```

脚注正文格式：`[^1]: **作者 · 时间**：评论内容 ↳ **回复者**：回复内容`。
锚点搜索会跳过 fenced code 区段，避免把脚注插进代码里。

---

## 5. UI / 视觉设计

**设计语言：「纸 × 墨 × 朱砂印」**

| Token | Light | Dark | 用途 |
| --- | --- | --- | --- |
| `--paper` | `#faf6ee` 宣纸米白 | `#1c1a17` 墨夜 | 背景 |
| `--ink` | `#2b2723` | `#ece5d8` | 正文 |
| `--cinnabar` | `#c0392b` 朱砂 | `#e05a48` | 品牌/主按钮/强调 |
| `--jade` | `#1e8e5a` | `#4dbb8a` | 成功状态 |

- **Logo**：一枚旋转 -3° 的朱砂印章「摘」，宋体衬线；品牌字「摘墨」同用衬线，UI 正文用系统无衬线——书卷气与工具感的平衡。
- **深色模式**：`prefers-color-scheme` 全自动跟随，两套 token 一一对应。
- **微交互**：墨滴加载动画（水滴形旋转 45°）、开关回弹曲线 `cubic-bezier(.4,1.6,.6,1)`、设置齿轮 hover 旋转。
- **popup 信息架构**：状态（适配器徽章 + 可编辑标题 + 统计）→ 决策（三个开关/分段）→ 动作（一主两次），自上而下一条视线完成导出。
- **预览页**：对照/效果/源码三视图，front matter 渲染为元数据 chip 条而非正文。

---

## 6. 质量保障

- `test/e2e.js`：真实 Chromium 中跑「fixture 页面 → 注入脚本链 → IR → Markdown」全流程，
  24 项断言覆盖两个适配器、评论编织、文件名净化。
- `test/fixtures/`：站点 HTML 快照。**平台改版导致适配器失效时，第一时间在这里复现**——
  把新版页面存成 fixture，修选择器，测试转绿即修复完成。这是这类插件最重要的维护基建。
- 扩展加载冒烟测试：`--load-extension` 启动真实 Chrome，确认 SW 启动、三个页面零控制台错误。

---

## 7. v2.1 增量设计

**用户自定义站点规则**（`adapters/custom.js` + 设置页「站点规则」）
- 规则 = `{ 规则名, URL 包含, 正文选择器, 标题选择器?, 剔除选择器? }`，不写代码即可精配任何站点。
- 注册在所有内置适配器**之前**：内置效果不佳时用户可直接覆盖；选择器失配自动回退通用模式并在 popup 告警——规则永远不会导致导出失败。

**批量导出**（`src/batch/`）
- 权限渐进：默认安装只有 activeTab；批量导出页在用户点击时 `permissions.request` 申请
  `tabs + <all_urls>`（manifest 声明为 optional），拒绝授权不影响单页功能。
- 逐个注入 → 取回 markdown → 单个 ZIP；每行状态独立展示，单页失败不阻塞整批。

**导出历史**（`exporter.recordHistory` + 设置页「导出历史」）
- 记录最近 30 次（下载/ZIP/复制/节选），单条正文 ≤300KB、全库 ≈3MB 超限只留元信息。
- 写入失败静默降级——历史是增值功能，绝不阻塞导出主链路。

**稳定性加固清单**
- 表格单元格扁平化：块级元素 → `<br>` 分行、代码块 → 行内 code、嵌套表格 → 文本，GFM 表格不再碎裂。
- 公式还原：KaTeX（annotation）/ MathJax v2（math/tex script）→ `<span data-ink-math>` → 专用
  Turndown 规则原样输出（文本节点方案会被 Turndown 转义 `\` 而报废；空元素会被 Readability 清除，
  所以标记元素必须携带文本内容——两个真实踩过的坑）。
- Confluence 评论分页拉全（`_links.next`，上限 10 页防御）。
- 图片抓取：4 路并发 + 单张 20s AbortController 超时 + data: URI 支持，失败保留远程链接。
- popup ↔ 页面消息：`Receiving end does not exist` 自动重注入重试一次；
  `INK_PROGRESS` 反向通道实时回显（飞书滚动采集百分比、图片抓取进度）。
- 零宽字符 / BOM / nbsp 清理；设置读取以页面侧 storage 为单一事实源，右键/快捷键/批量共享同一套默认值。

## 8. 路线图

- **v2.0**：适配器架构、通用兜底、Confluence 评论、5 个精配站点、图片 ZIP、预览页、右键节选、快捷键、设置页。✅
- **v2.1（本次）**：自定义站点规则、批量导出、导出历史、Markdown 风格定制、公式还原、
  表格扁平化、CSDN/语雀/Stack Overflow 适配器、稳定性加固。✅
- **v2.2**：飞书接口化采集（block 树 → IR，替代滚动采集）+ 飞书评论；腾讯文档专项（内部导出接口）。
- **v2.3**：Notion / Google Docs 适配器；Confluence 空间树 / 飞书知识库整库批量导出。
- **v3.0**：规则市场——自定义站点规则的导入/导出与社区共享。
