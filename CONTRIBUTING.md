# 开发指南

## 零构建哲学

摘墨刻意不使用构建工具：纯原生 JS，第三方库以独立版本直接放在 `src/lib/`，
manifest 直接引用源文件。这样"改选择器 → 扩展页点刷新 → 立即验证"的迭代循环最短——
这类插件的维护主体就是跟进平台改版。代价（无 TS 类型检查）由端到端测试兜底。

```bash
git clone git@github.com:jiangding01/wiki2md.git
cd wiki2md
# 没有 npm install，没有 build——直接在 chrome://extensions 加载本目录
```

## 运行测试

```bash
npm install playwright        # 仅测试需要，不进仓库（.gitignore 已排除）
node test/e2e.js              # 真实 Chromium 中跑全管线断言（当前数量见 README）
# 使用系统已有浏览器：
CHROMIUM_PATH=/path/to/chrome node test/e2e.js
```

## 修适配器的标准流程（最常见的维护任务）

平台改版导致提取失效时：

1. 把新版页面「另存为网页」，脱敏后放进 `test/fixtures/`；
2. 在 `test/e2e.js` 里为它加断言（或修改现有用例）；
3. 修改对应适配器的选择器/清洗逻辑，直到测试转绿。

fixture 是这个项目最重要的质量基建——每个真实环境暴露过的问题都有 fixture 锁定，
改任何代码都不会让它们复发。

## 新增站点适配器

1. 在 `src/adapters/` 新建文件，实现接口：
   `{ id, name, badge, match(location, document), extract(options) → IR }`，
   顶层声明用幂等形式 `var X = window.X || {...}`（防重复注入）；
2. 三处注册（漏任何一处都有一致性测试兜底报错）：
   - `src/background/background.js` 的 `CONTENT_FILES`
   - `src/core/pipeline.js` 底部的 `InkAdapters.register(...)`（顺序即优先级，Generic 必须最后）
   - `test/e2e.js` 的 `CONTENT_FILES`
3. 原则：适配器只负责「网页 → IR」，所有 Markdown 转换规则集中在 `src/core/markdown.js`；
   平台提示面板/代码块用 `InkIR.markCallout` / `markCodeBlock` 规范化标记，不要自转。

## 架构速览

```
adapters（每站点一个，Generic 兜底）→ IR（中间表示）→ markdown.js（唯一转换出口）→ exporter（输出）
pipeline.js = 内容脚本编排入口（消息驱动）；background = 注入/右键/快捷键，刻意最小化
```

完整设计文档与历次决策记录：[docs/DESIGN.md](docs/DESIGN.md)。

## 提交前检查

```bash
node test/e2e.js    # 全绿
# 手动冒烟：chrome://extensions 刷新扩展 → 在 Confluence/普通网页各导出一次
```
