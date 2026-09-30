import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import XLSX from 'xlsx';
import { FILE, HEADERS, WORKBOOK_SHA256, SOURCE_SYSTEM, hash, units, decimal, total, parseWorkbook,
  sourceAudit, dateFromCell, preflight, approvalFor, validateApproval, revalidateApproval, applyApproved, validateTarget, readState } from './import-historical-cpd-points.mjs';

const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const member = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const target = 'https://explicit-target.supabase.co';
function workbook(values) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADERS, ...values]), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const values = (id = 1, credits = '0.1') => [member, id, 'approved', 45929.5, 98765432, '', ' First ', 'Last', ' Original details \n', credits, '', '', `Code ${id}`, 'CPD', false];
function sourceFor(count = 1) {
  const bytes = workbook(Array.from({ length: count }, (_, i) => values(i + 1)));
  return parseWorkbook(bytes, { expectedHash: hash(bytes) });
}
const stateFor = () => ({ tenantExists: true, members: [{ id: member, tenant_id: tenant }], native: [], imported: [] });
const options = decisions => ({ target, tenant, decisions });

test('pinned actual workbook reconciles without network or PII output', () => {
  const source = parseWorkbook(readFileSync(FILE));
  const audit = sourceAudit(source);
  assert.equal(audit.workbook_sha256, WORKBOOK_SHA256);
  assert.equal(audit.row_count, 5904);
  assert.equal(audit.member_count, 2580);
  assert.equal(audit.points_total, '55284');
  assert.equal(audit.first_date, '2021-05-18');
  assert.equal(audit.last_date, '2026-09-15');
  assert.equal(audit.unlocked_rows, 63);
  assert.equal(audit.duplicate_groups.length, 7);
  assert.equal(audit.repeated_code_groups.length, 9);
  assert.equal(audit.live_matching, 'NOT CHECKED');
  assert.equal(audit.row_identities_sha256, 'e69c9f6a83812bc22855ddc91b0ffb6c3c856157e7bd21e92225ef8b79ae6677');
  assert.ok(source.rows.some(r => r.source_metadata.raw_numeric_cells['Entry Date'].includes('.')));
  assert.ok(source.rows.every(r => r.source_metadata.original.Expires === '' && r.source_metadata.original['Score (%)'] === ''));
});
test('parser preserves original strings, numeric lexemes, labels and fractional Excel date provenance', () => {
  const row = sourceFor().rows[0];
  assert.equal(row.activity_description, ' Original details \n');
  assert.equal(row.source_metadata.original['First Name'], ' First ');
  assert.equal(row.source_metadata.original.Locked, false);
  assert.equal(row.source_metadata.raw_numeric_cells['Entry Date'], '45929.5');
  assert.equal(row.activity_date, '2025-09-29');
  assert.equal(row.points_value, '0.1');
  assert.equal(row.activity_title, 'Code 1');
});
test('exact decimal arithmetic never rounds through Number', () => {
  assert.equal(decimal(units('99999999999999.999999') + units('0.000001')), '100000000000000');
  assert.equal(total([{ points_value: '0.1' }, { points_value: '0.2' }]), '0.3');
  assert.equal(decimal(units('0001.200000')), '1.2');
  for (const value of ['1e3', 'NaN', '0.0000001', '-1', '100000000000000', 0.1]) assert.throws(() => units(value));
});
test('fail closed on unpinned bytes, repeated Entry IDs, ambiguous dates, semantics, formulas and bad UUID', () => {
  const bytes = workbook([values()]);
  assert.throws(() => parseWorkbook(bytes), /fingerprint/);
  for (const edit of [
    r => { r[0] = 'name instead of UUID'; },
    r => { r[2] = 'pending'; },
    r => { r[9] = '1.0000001'; },
    r => { r[10] = '2026-01-01'; },
    r => { r[11] = 5; },
    r => { r[3] = '01/02/2025'; },
    r => { r[14] = 'false'; },
  ]) {
    const row = values(); edit(row);
    const b = workbook([row]);
    assert.throws(() => parseWorkbook(b, { expectedHash: hash(b) }));
  }
  const dup = workbook([values(), values()]);
  assert.throws(() => parseWorkbook(dup, { expectedHash: hash(dup) }), /repeated/);
  const wb = XLSX.read(bytes);
  wb.Sheets.Sheet1.J2 = { t: 'n', v: 1, f: '1+0' };
  const formula = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  assert.throws(() => parseWorkbook(formula, { expectedHash: hash(formula) }), /Formula/);
  assert.equal(dateFromCell('2024-02-29'), '2024-02-29');
  assert.throws(() => dateFromCell('2025-02-29'));
});
test('explicit target and tenant required; credentials and paths forbidden in target', () => {
  assert.throws(() => validateTarget(undefined, tenant));
  assert.throws(() => validateTarget(target, undefined));
  for (const value of ['https://user:secret@explicit-target.supabase.co', `${target}/`, `${target}?key=secret`, 'http://explicit-target.supabase.co']) assert.throws(() => validateTarget(value, tenant));
});
test('preflight reports exact UUID matched/missing/cross-tenant ownership and never fuzzy matches', () => {
  const source = sourceFor();
  let state = stateFor();
  assert.equal(preflight(source, state, options()).member_matching.matched, 1);
  state.members = [];
  assert.equal(preflight(source, state, options()).rows[0].member_match, 'missing');
  state.members = [{ id: member, tenant_id: other }];
  const report = preflight(source, state, options());
  assert.equal(report.member_matching.cross_tenant, 1);
  assert.equal(report.reconciliation.blocked.points, '0.1');
  assert.throws(() => approvalFor(source, report, 'reviewer'), /blocked/);
  state.tenantExists = false;
  assert.throws(() => preflight(source, state, options()), /tenant not found/);
});
test('duplicate-looking and repeated codes need individual keep/skip decisions, not auto deletion', () => {
  const a = values(1), b = values(2); b[12] = a[12];
  const bytes = workbook([a, b]);
  const source = parseWorkbook(bytes, { expectedHash: hash(bytes) });
  assert.equal(preflight(source, stateFor(), options()).reconciliation.blocked.rows, 2);
  const decisions = { 1: { action: 'keep', reason: 'Reviewed distinct activity' }, 2: { action: 'skip', reason: 'Confirmed duplicate' } };
  const report = preflight(source, stateFor(), options(decisions));
  assert.deepEqual(report.reconciliation, { accepted: { rows: 1, points: '0.1' }, skipped: { rows: 1, points: '0.1' }, blocked: { rows: 0, points: '0' } });
  assert.throws(() => preflight(source, stateFor(), options({ 999: { action: 'skip', reason: 'bad ID' } })), /decision/);
  assert.throws(() => preflight(source, stateFor(), options({ 1: { action: 'keep', reason: '' } })), /decision/);
});
test('existing content conflicts block, native awards require explicit review, skipped issues remain visible', () => {
  const source = sourceFor(), state = stateFor();
  state.imported = [{ tenant_id: tenant, source_system: SOURCE_SYSTEM, source_entry_id: '1', row_hash: 'changed' }];
  let report = preflight(source, state, options());
  assert.equal(report.rows[0].existing, 'conflict');
  assert.equal(report.reconciliation.blocked.rows, 1);
  state.imported = []; state.native = [{ id: 'native-id', member_id: member }];
  assert.equal(preflight(source, state, options()).reconciliation.blocked.rows, 1);
  report = preflight(source, state, options({ 1: { action: 'keep', reason: 'Separate activity confirmed', native_overlap_reviewed: true } }));
  assert.equal(report.reconciliation.accepted.rows, 1);
  report = preflight(source, state, options({ 1: { action: 'skip', reason: 'Overlap excluded' } }));
  assert.equal(report.reconciliation.skipped.rows, 1);
  assert.deepEqual(report.rows[0].native_overlap_ids, ['native-id']);
});
test('approval binds target, tenant, workbook, report, decisions and accepted hashes', () => {
  const source = sourceFor(), report = preflight(source, stateFor(), options());
  const approval = approvalFor(source, report, 'reviewer');
  validateApproval(source, approval, approval.approval_sha256, target, tenant);
  for (const edit of [
    a => { a.target = 'https://other.supabase.co'; },
    a => { a.tenant = other; },
    a => { a.workbook_sha256 = 'bad'; },
    a => { a.accepted_rows[0].row_hash = 'bad'; },
    a => { a.decisions[1] = { action: 'skip', reason: 'changed' }; },
    a => { a.report.rows[0].disposition = 'skipped'; },
  ]) {
    const changed = structuredClone(approval); edit(changed);
    assert.throws(() => validateApproval(source, changed, approval.approval_sha256, target, tenant));
  }
  assert.throws(() => validateApproval(source, approval, approval.approval_sha256, target, other), /mismatch/);
  assert.throws(() => validateApproval(source, approval, undefined, target, tenant), /hash/);
});
test('live revalidation permits replay but rejects new overlaps, ownership changes and changed source content', () => {
  const source = sourceFor(), state = stateFor();
  const approval = approvalFor(source, preflight(source, state, options()), 'reviewer');
  state.imported = [{ tenant_id: tenant, source_system: SOURCE_SYSTEM, source_entry_id: '1', row_hash: source.rows[0].row_hash }];
  assert.doesNotThrow(() => revalidateApproval(source, approval, state));
  state.imported[0].row_hash = 'bad';
  assert.throws(() => revalidateApproval(source, approval, state), /changed/);
  state.imported = []; state.native = [{ id: 'new', member_id: member }];
  assert.throws(() => revalidateApproval(source, approval, state), /changed/);
  state.native = []; state.members[0].tenant_id = other;
  assert.throws(() => revalidateApproval(source, approval, state), /changed/);
});
test('max100 transactional chunks, interrupted apply, resumed/replayed no-ops and exact reconciliation', async () => {
  const source = sourceFor(205), state = stateFor();
  const approval = approvalFor(source, preflight(source, state, options()), 'reviewer');
  let calls = 0, interrupt = true;
  const db = { rpc: async (name, args) => {
    assert.equal(name, 'import_historical_cpd_points_batch');
    assert.ok(args.p_rows.length <= 100);
    assert.equal(args.p_manifest.row_count, args.p_rows.length);
    assert.equal(args.p_manifest.points_total, total(args.p_rows));
    assert.equal(args.p_manifest.approval_sha256, approval.approval_sha256);
    assert.equal(args.p_actor, 'operator');
    calls++;
    if (interrupt && calls === 2) return { error: { message: 'must not leak secret' } };
    let applied = 0, skipped = 0;
    for (const row of args.p_rows) {
      if (state.imported.some(r => r.source_entry_id === row.source_entry_id)) skipped++;
      else {
        applied++;
        state.imported.push({ tenant_id: tenant, source_system: SOURCE_SYSTEM, source_entry_id: row.source_entry_id, row_hash: row.row_hash });
      }
    }
    return { data: { applied_count: applied, skipped_count: skipped, applied_points: decimal(BigInt(applied) * 100000n), skipped_points: decimal(BigInt(skipped) * 100000n) } };
  } };
  const params = { db, source, approval, approvalHash: approval.approval_sha256, target, tenant, actor: 'operator', read: async () => state };
  await assert.rejects(applyApproved(params), /Import transaction failed/);
  assert.equal(state.imported.length, 100);
  interrupt = false;
  const resumed = await applyApproved(params);
  assert.equal(resumed.applied_count, 105); assert.equal(resumed.skipped_count, 100);
  assert.equal(resumed.applied_points, '10.5'); assert.equal(resumed.skipped_points, '10');
  const replay = await applyApproved(params);
  assert.equal(replay.applied_count, 0); assert.equal(replay.skipped_count, 205);
  assert.equal(replay.skipped_points, '20.5');
  assert.equal(state.imported.length, 205);
});
test('RPC counts and decimal totals fail closed rather than accepting an unverified write', async () => {
  const source = sourceFor(), state = stateFor();
  const approval = approvalFor(source, preflight(source, state, options()), 'reviewer');
  for (const data of [
    { applied_count: 2, skipped_count: 0, applied_points: '0.1', skipped_points: '0' },
    { applied_count: 1, skipped_count: 0, applied_points: '0.2', skipped_points: '0' },
    { applied_count: 1, skipped_count: 0, applied_points: 0.1, skipped_points: '0' },
  ]) await assert.rejects(applyApproved({ db: { rpc: async () => ({ data }) }, source, approval, approvalHash: approval.approval_sha256, target, tenant, actor: 'operator', read: async () => state }));
});
test('read-state errors cannot silently become missing members and pagination is ordered', async () => {
  const methods = [];
  const query = new Proxy({}, { get: (_, name) => {
    if (name === 'then') return resolve => resolve({ data: null, error: { message: 'secret' } });
    return () => { methods.push(name); return query; };
  } });
  await assert.rejects(readState({ from: () => query }, sourceFor(), tenant), /Read-only preflight query failed: tenant/);
  assert.ok(methods.includes('order')); assert.ok(methods.includes('range'));
});