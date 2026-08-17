// Regression tests for Xero granular OAuth scopes (invalid_scope on apps
// created on/after 2 March 2026). Guards:
//  - both authorization entry points request the same granular scope set
//  - no code path requests the deprecated broad accounting.transactions or
//    write-capable accounting.settings scope
//  - token refresh never sends a scope parameter (existing tenants keep
//    their originally granted scopes)
// Run: node --test api/_lib/xeroScopes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const GRANULAR = [
  'offline_access',
  'openid',
  'profile',
  'email',
  'accounting.invoices',
  'accounting.payments',
  'accounting.contacts',
  'accounting.settings.read',
];

function scopesFromSource(src) {
  // Array form: const scopes = [ 'a', 'b', ... ].join(' ')
  const arr = src.match(/const scopes = \[([\s\S]*?)\]\.join\(' '\)/);
  if (arr) return [...arr[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // String form: scope: '...'
  const str = src.match(/scope: '([^']+)'/);
  if (str) return str[1].split(/\s+/);
  return null;
}

test('primary auth-url endpoint requests exactly the granular scope set', () => {
  const scopes = scopesFromSource(read('../xero/auth-url.js'));
  assert.deepEqual([...scopes].sort(), [...GRANULAR].sort());
});

test('legacy getXeroAuthUrl requests the same granular scope set', () => {
  const src = read('../functions/[functionName].js');
  const idx = src.indexOf('async getXeroAuthUrl');
  assert.ok(idx > -1, 'legacy getXeroAuthUrl exists');
  const scopes = scopesFromSource(src.slice(idx, idx + 3000));
  assert.deepEqual([...scopes].sort(), [...GRANULAR].sort());
});

test('no auth path requests deprecated broad scopes', () => {
  for (const rel of ['../xero/auth-url.js', '../functions/[functionName].js', '../xero/callback.js', './xero.js']) {
    const src = read(rel);
    for (const line of src.split('\n')) {
      if (line.trim().startsWith('//')) continue;
      assert.ok(!/['"\s]accounting\.transactions/.test(line), `${rel} must not request accounting.transactions: ${line.trim()}`);
      assert.ok(!/accounting\.settings['"\s]/.test(line) || /settings\.read/.test(line), `${rel} must not request write accounting.settings: ${line.trim()}`);
    }
  }
});

test('token refresh sends no scope parameter (existing grants preserved)', () => {
  const src = read('./xero.js');
  const refreshIdx = src.indexOf("grant_type: 'refresh_token'");
  assert.ok(refreshIdx > -1, 'refresh flow exists');
  const block = src.slice(refreshIdx, refreshIdx + 400);
  assert.ok(!/scope/.test(block), 'refresh request must not include a scope parameter');
});
