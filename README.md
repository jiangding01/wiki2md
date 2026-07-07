<div align="center">

# 摘墨 Inkmark

**把任意网页摘录为干净的 Markdown**

任意网页兜底导出 · Confluence / 飞书 / 微信公众号 / 知乎 / 掘金 精配
划线评论转脚注 · 页面评论附文末 · 图片打包 ZIP · Obsidian 友好

</div>

---

<div align="center">
<img src="docs/screenshots/popup-light.png" width="300" alt="摘墨 popup 浅色主题">&nbsp;&nbsp;<img src="docs/screenshots/popup-dark.png" width="300" alt="摘墨 popup 深色主题">
<br><br>
<img src="docs/screenshots/preview-light.png" width="640" alt="预览页：渲染效果与 Markdown 源码对照">
</div>

## 功能

- 🌐 **任意网页**：Readability 正文提取兜底，没有专门适配的网站也能导出
- 🎯 **站点精配**：Confluence（含评论）、飞书文档（实验性）、微信公众号、知乎、掘金
- 💬 **评论导出**：划线评论锚定为脚注 `[^1]`，页面评论汇入文末「💬 评论」区，回复嵌套呈现
- 🖼 **图片两种策略**：保留远程链接，或抓取（自动携带登录态）打包为 `assets/` + ZIP
- 📋 **多种出口**：下载 .md / 复制剪贴板 / 新标签页预览（对照·效果·源码三视图）
- ✂️ **右键节选**：选中任意内容 → 右键 → 导出为 Markdown
- ⌨️ **快捷键**：`Alt+Shift+M` 一键下载当前页
- 🗂 **YAML Front Matter**：标题/来源/作者/摘录时间，文件名模板 `{title} {domain} {date}`
- 🌙 **深浅色主题**自动跟随系统

## 安装（开发者模式）

1. 下载或 clone 本仓库
2. 打开 `chrome://extensions`，开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择仓库根目录

## 使用

点击工具栏上的朱砂印章图标 → 摘墨会自动分析当前页（显示命中的适配器、字数、图表与评论统计）→ 调整选项 → 下载 / 复制 / 预览。

设置页可配置默认行为：Front Matter、评论呈现方式（脚注/附录）、图片策略、文件名模板。

## 架构

```
适配器层（每站点一个，Generic 兜底） → 中间表示 IR → 唯一的 Markdown 转换器 → 输出层
```

完整设计文档见 [docs/DESIGN.md](docs/DESIGN.md)，包括各平台适配策略、评论导出设计、视觉规范与路线图。

## 开发与测试

```bash
npm install playwright          # 测试依赖（仅本地）
node test/e2e.js                # 真实 Chromium 中跑全管线断言
# 使用系统已有浏览器：CHROMIUM_PATH=/path/to/chrome node test/e2e.js
```

平台改版导致适配器失效时：把新版页面 HTML 存入 `test/fixtures/`，修对应适配器的选择器，测试转绿即修复。

## 第三方库

[Readability](https://github.com/mozilla/readability) · [Turndown](https://github.com/mixmark-io/turndown) (+ GFM 插件) · [JSZip](https://stuk.github.io/jszip/) · [marked](https://marked.js.org/)（仅预览页）

## License

见 [LICENSE](LICENSE)。
