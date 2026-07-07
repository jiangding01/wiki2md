const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

function walkFiles(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(abs));
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

async function main() {
  const distDir = path.join(__dirname, '..', 'dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist/ not found. Run `npm run build` first.');
  }

  const manifestPath = path.join(distDir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { name: 'wiki2md', version: '0.0.0' };

  const zip = new JSZip();
  const files = walkFiles(distDir);
  for (const abs of files) {
    const rel = path.relative(distDir, abs).replace(/\\/g, '/');
    zip.file(rel, fs.readFileSync(abs));
  }

  const safeName = String(manifest.name || 'wiki2md').replace(/[^a-z0-9_-]/gi, '_');
  const safeVersion = String(manifest.version || '0.0.0').replace(/[^0-9a-z._-]/gi, '_');
  const outName = `${safeName}-extension_${safeVersion}.zip`;
  const outPath = path.join(__dirname, '..', outName);

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  fs.writeFileSync(outPath, buf);
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

