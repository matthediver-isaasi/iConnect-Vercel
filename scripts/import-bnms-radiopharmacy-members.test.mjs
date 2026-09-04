import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EXPECTED_FILE_SHA256, FIELD_CONTRACTS, HEADERS, ROW_COUNT, TENANT_ID,
  auditMappings, makePlan, readSource, validateAppliedRows,
} from './import-bnms-radiopharmacy-members.mjs';

const source = readSource();
const fields = FIELD_CONTRACTS.map((field) => ({
  ...field, tenant_id: TENANT_ID, entity_scope: 'member', field_type: field.type, is_active: true,
  options: field.type === 'dropdown' ? [...new Set(source.rows.map((row) => row.values[field.source]))].map((value) => ({ label: value, value })) : null,
}));
const mappings = auditMappings(fields, source);
const members = source.rows.map((row) => ({ id: row.id, tenant_id: TENANT_ID, unrelated: `keep-${row.id}` }));

test('pins the exact 54-row CSV shape, fingerprint, IDs, and constants', () => {
  assert.equal(source.fingerprint, EXPECTED_FILE_SHA256);
  assert.equal(source.rows.length, ROW_COUNT);
  assert.deepEqual(HEADERS, ['id', 'YM Web Site Member ID', 'YM Membership type', 'Member class', 'Membership status']);
  assert.equal(new Set(source.rows.map((row) => row.id)).size, ROW_COUNT);
  assert.deepEqual(new Set(source.rows.map((row) => row.values['YM Membership type'])), new Set(['Radiopharmacy Departmental Contact']));
  assert.deepEqual(new Set(source.rows.map((row) => row.values['Member class'])), new Set(['Department contact']));
  assert.deepEqual(new Set(source.rows.map((row) => row.values['Membership status'])), new Set(['Active']));
});

test('rejects source fingerprint drift before parsing or writes', () => {
  const file = path.join(tmpdir(), `bnms-${process.pid}.csv`);
  copyFileSync(new URL('../attached_assets/Radiopharmacy_contacts_updated_31.08.26_1788196158731.csv', import.meta.url), file);
  writeFileSync(file, readFileSync(file, 'utf8').replace('Active', 'Inactive'));
  assert.throws(() => readSource(file), /fingerprint mismatch/);
});

test('requires exact tenant-owned active member fields and controlled options', () => {
  assert.equal(mappings.length, 4);
  assert.throws(() => auditMappings([...fields, { ...fields[0], id: 'other' }], source), /unambiguous/);
  assert.throws(() => auditMappings(fields.map((field, i) => i ? field : { ...field, tenant_id: 'other' }), source), /contract drifted/);
  assert.throws(() => auditMappings(fields.map((field, i) => i === 1 ? { ...field, options: [] } : field), source), /Unsupported/);
});

test('fails closed for missing, duplicate, and cross-tenant Member IDs', () => {
  assert.throws(() => makePlan(source, members.slice(1), [], mappings), /missing=1/);
  assert.throws(() => makePlan(source, [...members, members[0]], [], mappings), /duplicate=1/);
  assert.throws(() => makePlan(source, members.map((member, i) => i ? member : { ...member, tenant_id: 'other' }), [], mappings), /crossTenant=1/);
});

test('plans mixed inserts, updates, unchanged values and preserves Member objects', () => {
  const before = structuredClone(members);
  const first = source.rows[0];
  const values = [
    { id: 'a', member_id: first.id, field_id: mappings[0].id, value: first.values[mappings[0].source] },
    { id: 'b', member_id: first.id, field_id: mappings[1].id, value: 'old' },
  ];
  const plan = makePlan(source, members, values, mappings);
  assert.equal(plan.departmentAssignmentMode, 'preserve');
  assert.equal(plan.departmentIds, null);
  assert.equal(plan.items.filter((item) => item.action === 'unchanged').length, 1);
  assert.equal(plan.items.filter((item) => item.action === 'update').length, 1);
  assert.equal(plan.items.filter((item) => item.action === 'insert').length, ROW_COUNT * 4 - 2);
  assert.deepEqual(members, before);
});

test('rejects duplicate destination values and exact replay proposes zero writes', () => {
  const all = source.rows.flatMap((row) => mappings.map((mapping, index) => ({
    id: `${row.id}-${index}`, member_id: row.id, field_id: mapping.id, value: row.values[mapping.source],
  })));
  assert.ok(makePlan(source, members, all, mappings).items.every((item) => item.action === 'unchanged'));
  assert.throws(() => makePlan(source, members, [...all, { ...all[0], id: 'duplicate' }], mappings), /Duplicate preference values/);
});

test('fails closed on partial or unexpected write results', () => {
  const writes = [
    { member_id: source.rows[0].id, field_id: mappings[0].id, value: 'one' },
    { member_id: source.rows[1].id, field_id: mappings[0].id, value: 'two' },
  ];
  assert.throws(() => validateAppliedRows(writes.slice(0, 1), writes), /1\/2 rows/);
  assert.throws(() => validateAppliedRows([{ ...writes[0], value: 'wrong' }, writes[1]], writes), /unexpected rows/);
  assert.doesNotThrow(() => validateAppliedRows(writes, writes));
});