// Always use the repository's pinned environment, regardless of global PATH.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const python = path.join(__dirname, 'env', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!fs.existsSync(python)) {
  console.error('Graphify environment missing. Follow .graphify/SETUP.md to install graphifyy==0.9.89 in .graphify/env.');
  process.exit(1);
}
const args = process.argv.slice(2);
const local = ['build', 'check', 'status', 'watch', 'hook', 'stop-hook'].includes(args[0]);
const result = spawnSync(python, local ? [path.join(__dirname, 'project.py'), ...args] : ['-m', 'graphify', ...args], {
  cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1', GRAPHIFY_NO_AUTO_REFRESH: '1', GRAPHIFY_OUT: path.join(__dirname, 'output') },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
