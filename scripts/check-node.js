/* eslint-disable no-console */

// Keep this file compatible with older Node runtimes (no optional chaining, etc.).
// It provides a clear error message instead of cryptic syntax errors when tooling
// (e.g. TypeScript) requires a newer Node version.

function getMajor(version) {
  var m = String(version || '').match(/^v?(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function main() {
  if (process.env.WIKI2MD_SKIP_NODE_CHECK === '1') return;

  var requiredMajor = 18;
  var major = getMajor(process.version);
  if (major >= requiredMajor) return;

  console.error('');
  console.error('[wiki2md] Node.js version is too old for this project.');
  console.error('  - Required: Node >= ' + requiredMajor);
  console.error('  - Current:  ' + process.version);
  console.error('');
  console.error('Tip: run `nvm use` (see `.nvmrc`) and then retry.');
  console.error('If you know what you are doing, set WIKI2MD_SKIP_NODE_CHECK=1 to bypass.');
  console.error('');
  process.exit(1);
}

main();

