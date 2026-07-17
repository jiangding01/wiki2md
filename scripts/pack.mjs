#!/usr/bin/env node
/**
 * 摘墨 · 分发打包
 *
 * 用法：node scripts/pack.mjs
 * 产物：dist/inkmark-v<版本号>.zip（版本号取自 manifest.json）
 *
 * 只打包运行时必需品——manifest / src / assets 三样，外加 LICENSE 与
 * PRIVACY.md（许可合规与权限说明）。test/docs/CI 等开发资产一律不进包。
 * 项目零构建，src/ 即最终产物，无编译步骤。
 */
import { readFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['manifest.json', 'src', 'assets', 'LICENSE', 'PRIVACY.md'];

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  console.error(`manifest.json 版本号形态异常：${manifest.version}`);
  process.exit(1);
}

const missing = INCLUDE.filter((p) => !existsSync(join(ROOT, p)));
if (missing.length) {
  console.error(`缺少必需文件：${missing.join(', ')}`);
  process.exit(1);
}

const outDir = join(ROOT, 'dist');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `inkmark-v${manifest.version}.zip`);
// zip 对已存在的包是「增量更新」语义，旧产物先删干净
rmSync(outFile, { force: true });

execFileSync('zip', ['-r', '-q', outFile, ...INCLUDE, '-x', '*.DS_Store'], {
  cwd: ROOT,
  stdio: 'inherit',
});

const kb = (statSync(outFile).size / 1024).toFixed(0);
console.log(`✅ 已打包 dist/inkmark-v${manifest.version}.zip（${kb} KB）`);
console.log('   分发：发给对方 → 解压 → chrome://extensions → 开发者模式 → 加载已解压的扩展程序');
