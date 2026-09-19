import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { existsSync, readFileSync } from 'node:fs';
import { TENANT_ID, verifyOrCompensate } from './import-bnms-direct-debit-members.mjs';
import { FOCUS_AREA } from './import-bnms-uk-individual-members.mjs';
import { FILE, HEADERS, CUSTOM_MAPPINGS, parseSourceBytes, dateValue, valueFor, makePlan, pendingItems, preservationSnapshot, heldCsv, main } from './import-bnms-additional-members.mjs';

const group = '00000000-0000-4000-8000-000000000001';
const organization = '00000000-0000-4000-8000-000000000002';
function bytes(change = () => {}) {
  const grid = [[...HEADERS], ...Array.from({ length: 96 }, (_, i) => {
    const r = Array(31).fill('');
    r[0] = `LEGACY-${i}`; r[1] = 'Active'; r[3] = 'Guest'; r[4] = 'CPD Guest';
    r[5] = 'Synthetic'; r[6] = String(i); r[8] = `synthetic${i}@example.invalid`; r[10] = '00123456789';
    r[21] = 'No'; r[23] = 'South Thames';
    if (i < 36) r[13] = group; else if (i < 74) r[14] = organization;
    return r;
  })];
  change(grid);
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(grid), 'Sheet1');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
const source = parseSourceBytes(bytes(), { verifyFingerprint: false });
function state() {
  return {
    members: [], legacy: [], preferences: [], memberCategories: [], edges: [],
    groups: [{ id: group, tenant_id: TENANT_ID }], organizations: [{ id: organization, tenant_id: TENANT_ID, organization_group_id: group }],
    fields: CUSTOM_MAPPINGS.map(m => ({
      id: m.id, name: m.name, label: m.label, field_type: m.type, entity_scope: 'member', tenant_id: TENANT_ID, is_active: true,
      options: m.type === 'dropdown' ? [...new Set(source.rows.map(r => r.values[m.column]))].map(value => ({ value, label: value })) : null,
    })),
    categories: [{ id: FOCUS_AREA.id, name: FOCUS_AREA.name, tenant_id: TENANT_ID, is_active: true, subcategories: ['Bone'] }],
  };
}
test('source contract, opaque phone, missing created_on, fingerprint and headers', () => {
  assert.equal(source.rows.length, 96); assert.equal(source.rows[0].values[10], '00123456789');
  assert.throws(() => parseSourceBytes(bytes()), /fingerprint/);
  assert.throws(() => parseSourceBytes(bytes(g => { g[0][0] = 'wrong'; }), { verifyFingerprint: false }), /header/);
  const plan = makePlan(source, state(), true);
  assert.equal(plan.items.length, 96); assert.equal('created_on' in plan.items[0].patch, false);
});
test('pinned protected workbook if available', { skip: !existsSync(FILE) }, () => {
  const real = parseSourceBytes(readFileSync(FILE));
  assert.equal(real.rows.length, 96);
  assert.equal(real.rows.filter(r => r.reasons.some(s => s.startsWith('Unmapped'))).length, 69);
});
test('mixed date formats and boolean transforms never invent dates', () => {
  assert.equal(dateValue('2027-09-11'), '2027-09-11');
  assert.equal(dateValue('04/08/2028'), '2028-08-04');
  assert.equal(dateValue('45839', true), '2025-07-01');
  assert.throws(() => dateValue('2027-02-29'));
  assert.throws(() => dateValue('60', true));
  assert.equal(valueFor({ transform: 'boolean' }, 'No'), 'false');
  assert.throws(() => valueFor({ transform: 'boolean' }, 'FALSE'));
});
test('holds entire rows with unmapped supplied cells, unsupported values and invalid source', () => {
  const changed = parseSourceBytes(bytes(g => { g[1][11] = 'Employer'; g[2][24] = 'id|file.pdf'; g[3][22] = 'Qualification'; g[4][8] = g[5][8]; g[6][10] = '1.2E+10'; }), { verifyFingerprint: false });
  const plan = makePlan(changed, state(), true);
  assert.equal(plan.held.length, 6);
  const s = state(); s.fields.find(f => f.name === 'member_region').options = [];
  assert.equal(makePlan(source, s, true).held.length, 96);
  assert.equal(makePlan(source, state(), false).items.length, 0);
});
test('tenant-safe hierarchy and normalized legacy collision checks', () => {
  const s = state(); s.groups[0].tenant_id = 'foreign';
  assert.equal(makePlan(source, s, true).items.length, 22);
  const s2 = state(); s2.legacy = [{ member_id: 'outside', value: ` ${source.rows[0].legacyId} ` }];
  assert.ok(makePlan(source, s2, true).held.some(r => r.sourceRow === 2));
  const s3 = state(); s3.members = [{ id: 'one', tenant_id: TENANT_ID, email: source.rows[0].email }, { id: 'two', tenant_id: TENANT_ID, email: 'old@example.invalid' }];
  s3.legacy = [{ member_id: 'two', value: source.rows[0].legacyId }];
  assert.ok(makePlan(source, s3, true).held[0].reasons.includes('Email and legacy ID match different members'));
});
test('preserves nonblank conflicts, blank source, replay and normalized email', () => {
  const s = state(); const row = source.rows[0]; const initial = makePlan({ rows: [row] }, s, true).items[0];
  const member = { id: 'member', tenant_id: TENANT_ID, ...initial.patch, created_on: '2001-01-01', job_title: 'preserve' };
  s.members = [member];
  s.preferences = initial.preferences.map((p, i) => ({ id: `p${i}`, member_id: member.id, field_id: p.mapping.id, value: p.desired }));
  s.legacy = s.preferences.filter(p => p.field_id === CUSTOM_MAPPINGS[0].id);
  assert.equal(pendingItems(makePlan({ rows: [row] }, s, true)).length, 0);
  member.email = member.email.toUpperCase();
  assert.equal(makePlan({ rows: [row] }, s, true).items[0].patch.email, row.email);
  member.first_name = 'Existing';
  assert.ok(makePlan({ rows: [row] }, s, true).held[0].reasons.includes('Conflicting nonblank first_name'));
});
test('CSV preserves original row cells, quotes and formula sanitization', () => {
  const row = { ...source.rows[0], reasons: ['Missing field'], original: [...source.rows[0].original] };
  row.original[11] = '=HYPERLINK("bad")';
  const csv = heldCsv([row]); assert.ok(csv.includes('00123456789')); assert.ok(csv.includes(`"'=HYPERLINK(""bad"")"`));
  assert.ok(csv.includes('Hold reasons'));
});
test('preservation detects held/unmanaged changes and compensation executes backwards', async () => {
  const s = state(); s.members = [{ id: 'held', tenant_id: TENANT_ID, email: 'held@example.invalid', mobile: 'old' }];
  const before = preservationSnapshot(s, { items: [] }); s.members[0].mobile = 'changed';
  assert.notEqual(preservationSnapshot(s, { items: [] }), before);
  const rolled = [];
  await assert.rejects(verifyOrCompensate([{ label: 'first', rollback: async () => rolled.push(1) }, { label: 'second', rollback: async () => rolled.push(2) }], async () => { throw Error('readback failed'); }), /readback/);
  assert.deepEqual(rolled, [2, 1]);
  await assert.rejects(main(['--unknown']), /Usage/);
});