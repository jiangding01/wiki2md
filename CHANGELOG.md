# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。日志格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)。

## [未发布]

### 内部重构

- 设置存储收敛为 `core/settings.js` 单一实现（InkSettings：DEFAULTS / read / write / update / reset），
  替换 pipeline / popup / options / background 四处重复代码与三份默认值表——行为无变化
- 适配器提取样板下沉：`InkIR.buildContainer / normalizeContainer / pickTitle / pickText`，
  七个精配适配器与选区导出统一接入，修复各适配器清洗顺序不一致的隐患。
  注意：自定义站点规则的 `removeSel` 现在在懒加载修复**之后**执行——依赖懒加载占位状态的
  选择器（如 `img[src^="data:image/gif"]`）请改为匹配真实 src 或 `data-src` 属性
- 界面页共享层：`ui/tokens.css`（设计 token 唯一定义处，四页暗色一致性补齐）+
  `ui/shared.js`（escapeHtml 补单引号转义 / downloadBlob 统一锚点入 DOM 版本）
- 页面树导出并行化：同层子页面 3 路并发抓取，渲染与图片本地化进同一并发池重叠执行；
  对源站总并发压在 6 以内（浏览器同主机连接上限），避免触发企业站点限流
- stats() 字数统计改单趟码位计数，百万字文档不再产生海量临时分配

### 修复（合并前代码审查）

- 页面树导出触达 300 页上限后未真正停止：队列被本层子页面重新填回，继续发多余的
  REST 请求并重复写「超出上限」报告——现改为硬停（触顶层只导出、不再下钻）
- 页面树导出中单页转换/本地化异常会中断整个导出且遗留后台孤儿请求——
  现降级为该页保留远程链接并计入导出报告
- `InkSettings.update` 串行化：popup 里快速连点两个开关时，后一次读-改-写可能
  用旧快照覆盖掉前一次刚保存的偏好
- `InkSettings.DEFAULTS` 冻结（含 customRules 数组），杜绝共享默认值被调用方原地修改污染
- stats() 元素分类改用 `localName`，XHTML 页面上图片/表格数不再误计为代码块

## [1.0.0] - 2026-07-07

摘墨 Inkmark 首个正式版。由原 wiki2md（仅支持 Confluence 单页导出，归档于 `legacy-v1` 分支）
完全重写而来；开发期内部迭代（2.0.0–2.4.6）的完整过程见 git 提交历史与 `docs/DESIGN.md`。

### 核心能力

- **适配器架构**：站点适配器 → 中间表示（IR）→ 唯一的 Markdown 转换器 → 输出层；
  通用网页由 Readability 兜底，任何站点都能导出
- **9 个精配适配器**：Confluence（含评论）、飞书文档（实验性）、微信公众号、知乎、
  掘金、CSDN、语雀、Stack Overflow（问题 + 全部回答结构化），另有用户自定义规则引擎
- **评论导出**：划线评论默认「==高亮==[^脚注]」锚定原文位置，页面评论与嵌套回复进
  文末「💬 评论」区；无锚点自动降级附录，三层递降不丢数据（Confluence 全支持，自动分页拉全）
- **表格三档策略**：简单表转 GFM（单元格 `|` 转义）；合并单元格网格展开后转 GFM
  （源自 v1 插件的实战方案）；嵌套表格默认保留净化 HTML，可选强制扁平化
- **公式还原**：KaTeX / MathJax v2 / 知乎公式图 → `$LaTeX$`

### 导出方式

- 单页：下载 .md / 复制剪贴板 / 图片本地化打包 ZIP / 预览页（对照·效果·源码三视图，源码可编辑实时渲染，双栏同步滚动）
- **Confluence 页面树**：当前页 + 全部子孙页面一键导出（REST 驱动、不开标签页），
  ZIP 目录镜像层级，每页图片本地化进 `assets/<页面名>/`，失败清单写入导出报告
- **多标签页批量导出**：勾选当前窗口任意页面打包 ZIP（按需授权、自动唤醒休眠标签页）
- 右键导出整页/选中节选；`Alt+Shift+M` 快捷键；导出历史（最近 30 次可找回）

### 个性化设置

- Markdown 风格：列表符号 / 强调符号 / 代码围栏 / 链接样式 / 复杂表格策略
- Front Matter 开关与自定义 tags、文件名模板（`{title}` `{domain}` `{date}`）
- 自定义站点规则（URL 包含 + CSS 选择器，无需写代码）、配置导入/导出/恢复默认

### 稳定性与安全

- 被摘录页面按不可信输入处理：危险协议链接摘除、保留 HTML 净化、预览页 DOM 级消毒
- 鉴权图片站点（Confluence/飞书/语雀）自动切换「本地打包」；HTML 块内 `<img>` 同样本地化
- 文件名 `& # %` 换全角，规避各家 Markdown 编辑器的链接目标解析差异
- SPA 缓存按 URL 失效、并发提取去重、重复注入幂等、导出互斥忙态
- 85 项端到端断言（真实 Chromium 全管线）+ 扩展加载冒烟测试

[1.0.0]: https://github.com/jiangding01/wiki2md/releases/tag/v1.0.0
