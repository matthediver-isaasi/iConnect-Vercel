import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EXPECTED_FILE_SHA256, FIELD_NAME, ROW_COUNT, TENANT_ID,
  auditField, makePlan, readSource,
} from './set-bnms-survey-respondents.mjs';

const source = readSource();
const field = {
  id: '11111111-1111-4111-8111-111111111111',
  tenant_id: TENANT_ID,
  name: FIELD_NAME,
  label: 'Survey respondent',
  field_type: 'boolean',
  entity_scope: 'member',
  is_active: true,
};
const members = source.rows.map((row) => ({ id: row.id, tenant_id: TENANT_ID }));

test('pins the exact 53-row source and requires canonical true intent', () => {
  assert.equal(source.fingerprint, EXPECTED_FILE_SHA256);
  assert.equal(source.rows.length, ROW_COUNT);
  assert.equal(new Set(source.rows.map((row) => row.id)).size, ROW_COUNT);
  assert.ok(source.rows.every((row) => row.desired === 'true'));
});

test('rejects source fingerprint drift', () => {
  const file = path.join(tmpdir(), `bnms-survey-${process.pid}.csv`);
  copyFileSync(new URL('../attached_assets/Individual_survey_respondants_1788548366967.csv', import.meta.url), file);
  writeFileSync(file, readFileSync(file, 'utf8').replace('TRUE', 'FALSE'));
  assert.throws(() => readSource(file), /fingerprint mismatch/);
});

test('requires exactly one active member-scoped boolean field', () => {
  assert.equal(auditField([field]), field);
  assert.throws(() => auditField([]), /exactly one/);
  assert.throws(() => auditField([field, { ...field, id: 'other' }]), /exactly one/);
  assert.throws(() => auditField([{ ...field, entity_scope: 'organization' }]), /member-scoped boolean/);
  assert.throws(() => auditField([{ ...field, field_type: 'text' }]), /member-scoped boolean/);
});

test('fails closed on missing, duplicate, and cross-tenant Members', () => {
  assert.throws(() => makePlan(source, members.slice(1), [], field), /missing=1/);
  assert.throws(() => makePlan(source, [...members, members[0]], [], field), /rejected=1/);
  assert.throws(() => makePlan(source, members.map((member, index) => index ? member : { ...member, tenant_id: 'other' }), [], field), /rejected=1/);
});

test('classifies inserts, updates, and unchanged values without changing unrelated data', () => {
  const before = structuredClone(members);
  const values = [
    { id: 'a', member_id: members[0].id, field_id: field.id, value: 'true' },
    { id: 'b', member_id: members[1].id, field_id: field.id, value: 'false' },
  ];
  const plan = makePlan(source, members, values, field);
  assert.equal(plan.inserted, ROW_COUNT - 2);
  assert.equal(plan.updated, 1);
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.missing, 0);
  assert.equal(plan.rejected, 0);
  assert.deepEqual(members, before);
});

test('rejects duplicate destination values and replay proposes zero writes', () => {
  const values = members.map((member, index) => ({
    id: String(index), member_id: member.id, field_id: field.id, value: 'true',
  }));
  assert.equal(makePlan(source, members, values, field).unchanged, ROW_COUNT);
  assert.throws(() => makePlan(source, members, [...values, { ...values[0], id: 'duplicate' }], field), /Duplicate/);
});