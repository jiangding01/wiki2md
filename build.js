const path = require('path');
const fs = require('fs');

function maybeSetEsbuildBinaryPath() {
  if (process.env.ESBUILD_BINARY_PATH) return;

  // Best-effort fix for "installed for another platform" issues that can happen
  // when Node is running under Rosetta or when node_modules were installed with
  // a different architecture.
  const base = path.join(__dirname, 'node_modules', '@esbuild');

  const exists = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };

  const binPathFor = (pkg) => path.join(base, pkg, 'bin', 'esbuild');

  // Prefer the binary matching the current platform/arch, otherwise fall back
  // to any available darwin binary (many are universal in practice).
  const candidates = [];
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    candidates.push(`darwin-${arch}`);
    if (arch === 'x64') candidates.push('darwin-arm64');
    if (arch === 'arm64') candidates.push('darwin-x64');
  } else {
    candidates.push(`${platform}-${arch}`);
  }

  for (const pkg of candidates) {
    const p = binPathFor(pkg);
    if (!exists(p)) continue;
    process.env.ESBUILD_BINARY_PATH = p;
    return;
  }
}

function parseArgs(argv) {
  const args = { watch: false, outdir: 'dist' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--watch') args.watch = true;
    else if (a === '--outdir') args.outdir = argv[++i] || args.outdir;
  }
  return args;
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  // Node 12 compatibility: fs.rmSync was added in Node 14.14.
  if (typeof fs.rmSync === 'function') {
    fs.rmSync(p, { recursive: true, force: true });
    return;
  }
  // Fallback: manually remove files/directories.
  const stat = fs.lstatSync(p);
  if (!stat.isDirectory()) {
    fs.unlinkSync(p);
    return;
  }
  const entries = fs.readdirSync(p);
  for (const name of entries) {
    rmrf(path.join(p, name));
  }
  fs.rmdirSync(p);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dest) {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else if (e.isFile()) fs.copyFileSync(from, to);
  }
}

async function main() {
  maybeSetEsbuildBinaryPath();
  // Require esbuild after ESBUILD_BINARY_PATH is set (if needed). This avoids
  // architecture mismatch checks running before we can override the binary path.
  // eslint-disable-next-line global-require
  const esbuild = require('esbuild');
  const { watch, outdir } = parseArgs(process.argv.slice(2));
  const absOutdir = path.resolve(outdir);

  rmrf(absOutdir);
  ensureDir(absOutdir);

  // Copy static files (manifest, html, icons, etc.)
  copyDir(path.join(__dirname, 'public'), absOutdir);

  const buildOptions = {
    bundle: true,
    platform: 'browser',
    target: ['chrome88'],
    sourcemap: true,
    logLevel: 'info',
  };

  const entryPoints = [
    { in: 'src/popup.ts', out: 'popup' },
    { in: 'src/content.ts', out: 'content' },
    { in: 'src/options.ts', out: 'options' },
  ];

  if (watch) {
    const ctx = await esbuild.context({
      ...buildOptions,
      entryPoints,
      outdir: absOutdir,
    });
    await ctx.watch();
    console.log(`Watching... output: ${outdir}`);
  } else {
    await esbuild.build({
      ...buildOptions,
      entryPoints,
      outdir: absOutdir,
    });
    console.log(`Build complete: ${outdir}`);
  }

  const buildInfo = {
    builtAt: new Date().toISOString(),
    node: { version: process.version, platform: process.platform, arch: process.arch },
    esbuild: (() => {
      try {
        // eslint-disable-next-line global-require
        return { version: require('esbuild/package.json').version };
      } catch {
        return { version: null };
      }
    })(),
  };
  fs.writeFileSync(path.join(absOutdir, 'build-info.json'), JSON.stringify(buildInfo, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
