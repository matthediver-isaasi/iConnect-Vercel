import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { TENANT, hash, buildAudit, repairItem, workbookBytes, parseCorrections, checkCurrent } from './bnms-job-title-repair-core.mjs';
const id = '00000000-0000-4000-8000-000000000001';
const member = { id, tenant_id: TENANT, job_title: 'I would like to learn more.\n=literal', first_name: '=Example', last_name: 'Test', updated_at: '2026-10-06' };
const snapshot = { tenant: { id: TENANT }, total: 1, members: [member] };
const evidence = [{ id, matches: [{ cohort: 'student', fingerprint: 'source-hash', row: 2, sourceValue: member.job_title, legacyMatch: true, equalsCurrent: true }] }];
const review = { snapshotHash: hash(snapshot), decisions: [{ id, expectedTitle: member.job_title, classification: 'note', reason: 'Individually reviewed application statement, not a title.' }] };
const audit = buildAudit(snapshot, evidence, review);
test('confirmed notes preserve exact content, truthful provenance and deterministic identity', () => {
  const item = repairItem(audit[0]);
  assert.ok(item.note.content.endsWith(member.job_title));
  assert.equal(item.note.author_member_id, null);
  assert.equal(item.title, null);
  assert.deepEqual(item, repairItem(audit[0]));
});
test('mixed, mismatched and changed source values cannot be cleared', () => {
  assert.equal(buildAudit(snapshot, evidence, { ...review, decisions: [{ ...review.decisions[0], classification: 'ambiguous' }] })[0].classification, 'ambiguous');
  for (const patch of [{ legacyMatch: false }, { equalsCurrent: false }, { sourceValue: 'Other' }]) {
    assert.equal(buildAudit(snapshot, [{ id, matches: [{ ...evidence[0].matches[0], ...patch }] }], review)[0].classification, 'ambiguous');
  }
  assert.throws(() => buildAudit(snapshot, evidence, { ...review, snapshotHash: 'stale' }));
});
function edited(edit) {
  const w = XLSX.read(workbookBytes(audit, {}), { type: 'buffer' });
  edit(w.Sheets['Job titles']);
  return XLSX.write(w, { type: 'buffer', bookType: 'xlsx' });
}
test('workbook writes formula-like source strings literally and blank corrections skip', () => {
  const bytes = workbookBytes(audit, {});
  const w = XLSX.read(bytes, { type: 'buffer' });
  assert.equal(w.Sheets['Job titles'].B2.t, 's');
  assert.equal(w.Sheets['Job titles'].B2.f, undefined);
  assert.deepEqual(parseCorrections(bytes, audit), []);
});
test('roundtrip retains unicode, punctuation and literal formula-like text', () => {
  for (const value of ['Consultant – PET/CT', '=literal title', '+Specialist', '@Lead']) {
    const changes = parseCorrections(edited(s => { s.E2 = { t: 's', v: value }; }), audit);
    assert.equal(changes[0].title, value);
    assert.deepEqual(changes[0].before, member);
  }
});
test('returned workbook rejects duplicate, unknown, invalid and foreign identities', () => {
  assert.throws(() => parseCorrections(edited(s => { for (const c of ['A','B','C','D','E']) s[`${c}3`] = { ...s[`${c}2`] }; s['!ref'] = 'A1:E3'; }), audit), /Duplicate/);
  assert.throws(() => parseCorrections(edited(s => { s.A2.v = '00000000-0000-4000-8000-000000000002'; }), audit), /Unknown/);
  assert.throws(() => parseCorrections(edited(s => { s.A2.v = 'invalid'; }), audit), /Invalid/);
  assert.throws(() => parseCorrections(workbookBytes(audit, {}), [{ ...audit[0], member: { ...member, tenant_id: 'foreign' } }]), /off-tenant/);
});
test('formulas and edited immutable columns are rejected', () => {
  assert.throws(() => parseCorrections(edited(s => { s.E2 = { t: 's', f: 'HYPERLINK("x")', v: 'x' }; }), audit), /Formulas/);
  assert.throws(() => parseCorrections(edited(s => { s.C2.v = 'tampered'; }), audit), /Current title/);
});
test('concurrent edits, foreign identities and conflicting notes fail; exact cleanup replay skips', () => {
  const item = repairItem(audit[0]);
  assert.equal(checkCurrent(item, member), 'write');
  assert.throws(() => checkCurrent(item, { ...member, updated_at: 'later' }), /Stale/);
  assert.throws(() => checkCurrent(item, { ...member, tenant_id: 'other' }), /off-tenant/);
  assert.equal(checkCurrent(item, { ...member, job_title: null }, item.note), 'replay');
  assert.throws(() => checkCurrent(item, { ...member, job_title: 'Manual title' }, item.note), /changed/);
  assert.throws(() => checkCurrent(item, { ...member, job_title: null }, { ...item.note, content: 'changed' }), /differs/);
});
