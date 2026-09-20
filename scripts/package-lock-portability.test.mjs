import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lockText = readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8');
const lock = JSON.parse(lockText);
const resolvedUrls = Object.values(lock.packages)
  .map(entry => entry?.resolved)
  .filter(Boolean);

test('package lock uses portable package sources', () => {
  assert.doesNotMatch(lockText, /package-firewall\.replit\.(?:internal|local)/i);

  const npmRegistryUrls = resolvedUrls.filter(url =>
    url.startsWith('https://registry.npmjs.org/'));
  assert.ok(npmRegistryUrls.length > 0, 'expected public npm registry URLs');

  for (const url of resolvedUrls) {
    if (url.startsWith('https://registry.npmjs.org/')) continue;
    assert.match(
      url,
      /^(?:https:|git(?:\+https|\+ssh)?:|ssh:|file:|link:)/,
      `unexpected package source: ${url}`,
    );
  }
});