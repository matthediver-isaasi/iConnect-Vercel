import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { patchFor, planCurrent, assertBefore } from './apply-bnms-posters.mjs';
const report = JSON.parse(readFileSync('reports/bnms-posters/2026-09-15T13-50-57.289Z/audit.json'));
const approved = report.rows.filter(r=>r.status==='update');
test('exactly approved patches and zero-write replay',()=>{
  assert.equal(approved.length,920);
  const before = approved.map(r=>r.before);
  assert.equal(planCurrent(before,approved).filter(p=>!p.done).length,920);
  const after = approved.map(r=>({...r.before,...patchFor(r)}));
  assert(planCurrent(after,approved).every(p=>p.done));
  assert.equal(approved.filter(r=>'title' in patchFor(r)).length,191);
});
test('excluded row and unapproved fields fail closed',()=>{
  assert.throws(()=>patchFor(report.rows.find(r=>r.row===567)));
  const row = structuredClone(approved[0]);
  row.changes.resource_type = {before:row.before.resource_type,proposed:'download'};
  assert.throws(()=>patchFor(row),/Unapproved field/);
});
test('drift in modified or preserved fields fails',()=>{
  for (const field of ['title','target_url','tags','allowed_role_ids','resource_type','tenant_id']) {
    const rows = approved.map(r=>structuredClone(r.before));
    rows[0][field] = 'unexpected';
    assert.throws(()=>planCurrent(rows,approved));
  }
  assert.throws(()=>planCurrent([],approved));
});
test('timestamp encoding only is tolerated',()=>{
  assertBefore({release_date:'2025-01-01T00:00:00+00:00'},{release_date:'2025-01-01T00:00:00.000Z'});
  assert.throws(()=>assertBefore({release_date:'2025-01-02T00:00:00Z'},{release_date:'2025-01-01T00:00:00Z'}));
});