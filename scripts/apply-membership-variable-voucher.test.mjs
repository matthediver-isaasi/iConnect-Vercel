import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CONTRACTS, MIGRATION } from './apply-membership-variable-voucher.mjs';

test('variable voucher migration defaults offline and refuses unpinned writes or fallback targets', () => {
  const run=args=>spawnSync(process.execPath,['scripts/apply-membership-variable-voucher.mjs',...args],
    {encoding:'utf8',env:{PATH:process.env.PATH}});
  const offline=run([]);
  assert.equal(offline.status,0,offline.stderr);
  const result=JSON.parse(offline.stdout);
  assert.equal(result.migration,MIGRATION);
  assert.equal(result.writesPerformed,false);
  assert.match(result.sha256,/^[a-f0-9]{64}$/);
  assert.equal(Object.keys(CONTRACTS).length,6);
  assert.notEqual(run(['--apply']).status,0);
  assert.notEqual(run(['--apply',`--review-sha256=${result.sha256}`]).status,0);
  assert.notEqual(run(['--preflight']).status,0);
  assert.notEqual(run(['--apply','--preflight']).status,0);
});
