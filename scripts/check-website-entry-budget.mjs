// Build first: npx vite build --manifest --outDir /tmp/website-build
// Then: node scripts/check-website-entry-budget.mjs /tmp/website-build
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const directory = process.argv[2];
assert.ok(directory, 'Provide the Vite build output directory (built with --manifest)');
const manifest = JSON.parse(readFileSync(path.join(directory, '.vite/manifest.json'), 'utf8'));
const entry = Object.keys(manifest).find(key => manifest[key].isEntry && key.endsWith('index.html'));
assert.ok(entry, 'Missing application entry');
const visited = new Set();
function visit(key) {
  if (visited.has(key)) return;
  assert.ok(manifest[key], `Missing manifest dependency ${key}`);
  visited.add(key);
  for (const dependency of manifest[key].imports || []) visit(dependency);
}
visit(entry);
const files = [...new Set([...visited].map(key => manifest[key].file).filter(file => file.endsWith('.js')))];
const bytes = files.reduce((sum, file) => sum + readFileSync(path.join(directory, file)).length, 0);
const gzipBytes = files.reduce((sum, file) => sum + gzipSync(readFileSync(path.join(directory, file))).length, 0);
console.log(JSON.stringify({ files, bytes, gzipBytes }, null, 2));
// Count the complete static import graph, not only the renamed entry asset.
assert.ok(bytes < 9_000_000, `Initial JS graph exceeds 9 MB: ${bytes}`);
for (const name of ['CanvasPageRenderer', 'DueDiligenceDashboard', 'WorkflowManagement', 'AdminDashboard']) {
  // Vite may emit a shared renderer under a generated chunk key because
  // several independently lazy pages import it statically.
  const key = Object.keys(manifest).find(key => manifest[key].name === name);
  assert.ok(key, `${name} must remain a separate chunk`);
  assert.ok(!visited.has(key), `${name} leaked into the initial static graph`);
}
