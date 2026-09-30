import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('preview shared dependency graph has no raw client, network or effect escapes', async () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const visited = new Set();
  async function inspect(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = await readFile(file, 'utf8');
    // Trusted adapter construction occurs in the authorized route, outside
    // this graph. Every transitive family dependency must remain capability-only.
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/, file);
    assert.doesNotMatch(source, /\b(?:process\.env|globalThis|eval\s*\(|new\s+Function\b)/, file);
    assert.doesNotMatch(source, /\brequire\s*\(|\bimport\s*\(\s*[^'"\s]/, file);
    assert.doesNotMatch(source, /\bcreateClient\s*\(/, file);
    const imports = [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)];
    for (const [, specifier] of imports) {
      assert.doesNotMatch(specifier, /(?:^|\/)(?:database|supabase)(?:[./]|$)/, `Raw client import in ${file}`);
      if (specifier.startsWith('.')) await inspect(resolve(dirname(file), specifier));
      else assert.ok(['node:crypto'].includes(specifier), `Unexpected external dependency ${specifier} in ${file}`);
    }
  }
  await inspect(resolve(root, 'directDebitDryRun.js'));
  assert.ok(visited.size >= 5, 'All family entry points must be covered');
});