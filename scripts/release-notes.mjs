#!/usr/bin/env node
/**
 * 摘墨 · 发版说明提取（release workflow 用）
 *
 * 用法：node scripts/release-notes.mjs [tag] [输出文件]
 *   tag      默认取环境变量 GITHUB_REF_NAME（形如 v1.4.0），本地可用参数覆盖
 *   输出文件 默认 RELEASE_NOTES.md
 *
 * 职责：
 *   1. 发版门禁——校验 tag 版本号与 manifest.json 的 version 一致
 *      （防止「忘改 manifest 就打 tag」发出版本号错位的包）；
 *   2. 从 CHANGELOG.md 提取对应版本章节正文，作为 Release body；
 *   3. 把纯版本号（不带 v）写入 GITHUB_OUTPUT 的 version 字段，
 *      供 workflow 拼 Release 标题「摘墨 Inkmark <version>」。
 * 任一校验不过即非零退出，让发版流程快速失败。
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const tag = process.argv[2] || process.env.GITHUB_REF_NAME || '';
const outFile = process.argv[3] || join(ROOT, 'RELEASE_NOTES.md');

const version = tag.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`tag 形态异常，期望 vX.Y.Z，实际：「${tag}」`);
  process.exit(1);
}

// 门禁 1：tag 版本号必须与 manifest 一致
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
if (manifest.version !== version) {
  console.error(`版本号不一致：tag=${version}，manifest.json=${manifest.version}。` +
    `请先把 manifest 版本号改为 ${version} 再打 tag。`);
  process.exit(1);
}

// 门禁 2：CHANGELOG 必须有对应章节，且正文非空
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
// 匹配「## [1.4.0]…」到下一个「## [」之间（不含起止标题行）
const lines = changelog.split('\n');
const start = lines.findIndex((l) => new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`).test(l));
if (start === -1) {
  console.error(`CHANGELOG.md 里找不到 ## [${version}] 章节`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
if (end === -1) end = lines.length;

const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) {
  console.error(`CHANGELOG.md 的 [${version}] 章节正文为空`);
  process.exit(1);
}

writeFileSync(outFile, body + '\n');

// 把版本号回传给 workflow（供拼 Release 标题）
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}

console.log(`✅ 发版说明已写入 ${outFile}（版本 ${version}，${body.split('\n').length} 行）`);
