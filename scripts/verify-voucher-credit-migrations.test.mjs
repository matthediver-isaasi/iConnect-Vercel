import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { MIGRATIONS } from './verify-voucher-credit-migrations.mjs';

test('voucher runner is offline by default and cannot apply migrations', () => {
  const run = args => spawnSync(process.execPath, ['scripts/verify-voucher-credit-migrations.mjs', ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH,
      DEST_DATABASE_URL: '', DEST_SUPABASE_URL: '' } });
  const offline = run([]);
  assert.equal(offline.status, 0, offline.stderr);
  const report = JSON.parse(offline.stdout);
  assert.equal(report.mode, 'offline-review');
  assert.equal(report.writesPerformed, false);
  assert.deepEqual(report.migrations.map(row => row.name), MIGRATIONS);
  assert.ok(report.migrations.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
  assert.equal(new Set(MIGRATIONS.map(name => name.split('_')[0])).size, MIGRATIONS.length);
  assert.notEqual(run(['--apply']).status, 0);
  assert.notEqual(run(['--preflight', '--apply']).status, 0);
  assert.notEqual(run(['--preflight']).status, 0, 'must not fall back to workspace/source credentials');
});
