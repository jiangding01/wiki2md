<a id="readme-zh"></a>

# wiki2md（Chrome 插件）

[English](README.md#readme-en)

`wiki2md` 用于将当前 Confluence 页面导出为一个可离线使用的 `.zip`：

- `wiki_<标题>.md`（Markdown）
- `assets/`（已下载的图片）
- `meta.json`（导出元信息）

导出的 Markdown 文件开头会包含一段引用信息：原文链接 + 生成时间（北京时间，`YYYY-MM-DD HH:mm:ss`），便于后续追溯。

## 功能特性

- 一键导出：复用浏览器已登录的会话（对 SSO 友好）
- 图片保留：下载引用图片并重写为本地 `assets/` 路径
- 代码块保留：Confluence code macro / SyntaxHighlighter → fenced code block（尽量推断语言）
- 表格（尽力而为）：
  - 对 normalize 后满足“简单表格”规则的表格，可强制导出为 GitHub 风格 Markdown 表格
  - 复杂表格保留为精简后的 HTML（去除 `style/class/data-*` 等噪声属性）以减少 token
- 链接规范化：相对链接可配置转为绝对链接
- TOC 目录锚点修复：目录单独抽离渲染，并注入稳定的 `#toc-...` 文档内锚点，离线可跳转

## 安装（加载已解压）

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 构建插件：
   ```bash
   cd wiki2md
   npm ci
   npm run build
   ```
5. 选择目录 `wiki2md/dist`

## 使用方式

1. 打开任意 Confluence 页面
2. 点击 **wiki2md** 插件图标
3. 点击 **Download .zip**

## 配置项（Options）

入口：`chrome://extensions` → **wiki2md** →「详情」→「扩展程序选项」

- 允许列表（为空表示允许全部站点）
- 平台开关（默认启用 Confluence，后续可扩展其他平台）
- 强制 Markdown 表格（仅对“简单表格”生效）
- 相对链接转绝对链接
- 图片下载并发

## 产物说明

下载得到的 `.zip` 中包含：

- `wiki_<标题>.md`
- `assets/`
- `meta.json`（原文 URL/标题/时间、图片统计、失败列表等）

## 隐私与安全

- `wiki2md` 在本地浏览器中运行，不会将内容上传到任何第三方服务。
- 插件会使用你当前浏览器会话去拉取页面内资源（例如图片，`credentials: include`）。
- 导出的 Markdown 与 `meta.json` 会包含原文链接，也可能包含内部链接/内容；对外分享前请自行检查与脱敏。

## 开发说明

```bash
cd wiki2md
nvm use
npm run check
```

`npm run check` 会一次执行 `typecheck + build`。

### 打包

```bash
cd wiki2md
npm run package
```

会在 `wiki2md/` 下生成类似 `wiki2md-extension_1.0.zip` 的版本化压缩包。

## 常见问题

- 修改未生效：到 `chrome://extensions` 中点击插件的「重新加载」
- 构建失败：
  - 建议使用 Node 18+（参考项目内 `.nvmrc`）
  - Apple Silicon 机器避免混用 Rosetta x64 Node 与 ARM64 的 `node_modules`
  - 如果提示 Node 版本过低，先执行 `nvm use` 再重试（必要时可通过设置 `WIKI2MD_SKIP_NODE_CHECK=1` 跳过检查）。
