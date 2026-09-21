import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDdOwnerForSubmission } from './ddOwner.js';

const schema = {
  form_submission_due_diligence: ['form_submission_id', 'tenant_id', 'owner_name', 'owner_member_id'],
  member: ['id', 'tenant_id', 'email'],
  form_submission: ['id', 'tenant_id', 'form_id'],
  form_due_diligence_config: ['tenant_id', 'form_id', 'default_owner_name'],
};
const empty = { ownerName: '', ownerEmail: '' };
const assigned = { ownerName: 'Assigned Owner', ownerEmail: 'owner@example.invalid' };

function fixture() {
  const rows = {
    form_submission_due_diligence: [{ tenant_id: 'a', form_submission_id: 'sub', owner_name: assigned.ownerName, owner_member_id: 'member' }],
    member: [{ tenant_id: 'a', id: 'member', email: assigned.ownerEmail }],
    form_submission: [{ tenant_id: 'a', id: 'sub', form_id: 'form' }],
    form_due_diligence_config: [{ tenant_id: 'a', form_id: 'form', default_owner_name: 'Default Owner' }],
  };
  const calls = [];
  const failures = {};
  const db = {
    from(table) {
      const filters = {};
      let columns = [];
      return {
        select(value) { columns = value.split(',').map(s => s.trim()); return this; },
        eq(key, value) { filters[key] = value; return this; },
        async maybeSingle() {
          calls.push({ table, columns, filters });
          const unsupported = [...columns, ...Object.keys(filters)].find(c => !schema[table]?.includes(c));
          if (unsupported) return { data: null, error: { code: '42703', message: `Unknown column ${unsupported}` } };
          if (failures[table]?.throws) throw failures[table].throws;
          if (failures[table]) return { data: rows[table][0], error: failures[table] };
          const matches = rows[table].filter(row => Object.entries(filters).every(([k, v]) => row[k] === v));
          if (matches.length > 1) return { data: null, error: { code: 'PGRST116' } };
          return { data: matches[0] ? Object.fromEntries(columns.map(c => [c, matches[0][c]])) : null, error: null };
        },
      };
    },
  };
  return { rows, calls, failures, db, run: (args = {}) => resolveDdOwnerForSubmission({ supabase: db, tenantId: 'a', formSubmissionId: 'sub', ...args }) };
}

test('schema fixture rejects the original unsupported DD form_id projection', async () => {
  const f = fixture();
  const result = await f.db.from('form_submission_due_diligence').select('owner_name, owner_member_id, form_id').maybeSingle();
  assert.equal(result.error.code, '42703');
});

test('assigned owner name and member email take precedence over default', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), assigned);
  assert.deepEqual(f.calls[0].columns, ['owner_name', 'owner_member_id']);
  assert.ok(f.calls.every(c => c.filters.tenant_id === 'a'));
  assert.ok(!f.calls.some(c => c.table === 'form_due_diligence_config'));
});

test('default owner derives from linked submission, retaining assigned email', async () => {
  const f = fixture();
  f.rows.form_submission_due_diligence[0].owner_name = null;
  assert.deepEqual(await f.run(), { ownerName: 'Default Owner', ownerEmail: assigned.ownerEmail });
  assert.equal(f.calls.find(c => c.table === 'form_submission').filters.id, 'sub');
});

test('supplied form identity overrides derived form and works without submission', async () => {
  for (const formSubmissionId of ['sub', null]) {
    const f = fixture();
    f.rows.form_submission_due_diligence = [];
    f.rows.form_due_diligence_config.push({ tenant_id: 'a', form_id: 'explicit', default_owner_name: 'Explicit Default' });
    assert.deepEqual(await f.run({ formId: 'explicit', formSubmissionId }), { ownerName: 'Explicit Default', ownerEmail: '' });
    assert.ok(!f.calls.some(c => c.table === 'form_submission'));
  }
});

test('optional missing rows are quiet and return safe strings', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  for (const table of Object.keys(schema)) {
    const f = fixture();
    f.rows[table] = [];
    const result = await f.run();
    assert.equal(typeof result.ownerName, 'string');
    assert.equal(typeof result.ownerEmail, 'string');
    if (table === 'member') assert.deepEqual(result, { ...assigned, ownerEmail: '' });
    if (table === 'form_submission_due_diligence') assert.deepEqual(result, { ownerName: 'Default Owner', ownerEmail: '' });
  }
  const f = fixture();
  for (const table of Object.keys(schema)) f.rows[table] = [];
  assert.deepEqual(await f.run(), empty);
  assert.equal(warn.mock.callCount(), 0);
});

test('missing fallback configuration and invalid values collapse to empty strings', async () => {
  const f = fixture();
  f.rows.form_submission_due_diligence[0].owner_name = { invalid: true };
  f.rows.member[0].email = 123;
  f.rows.form_due_diligence_config[0].default_owner_name = null;
  assert.deepEqual(await f.run(), empty);
  f.rows.form_due_diligence_config = [];
  assert.deepEqual(await f.run(), empty);
});

for (const [table, stage, expected] of [
  ['form_submission_due_diligence', 'assignment', { ownerName: 'Default Owner', ownerEmail: '' }],
  ['member', 'member', { ...assigned, ownerEmail: '' }],
  ['form_submission', 'submission', empty],
  ['form_due_diligence_config', 'configuration', empty],
]) {
  for (const thrown of [false, true]) {
    test(`${stage} ${thrown ? 'exception' : 'database error'} is diagnosed without personal data`, async (t) => {
      const f = fixture();
      const warn = t.mock.method(console, 'warn', () => {});
      if (['submission', 'configuration'].includes(stage)) f.rows.form_submission_due_diligence = [];
      const error = { code: '42703', message: 'private@example.invalid', details: 'secret record', hint: 'private name' };
      f.failures[table] = thrown ? { throws: error } : error;
      assert.deepEqual(await f.run(), expected);
      assert.deepEqual(warn.mock.calls.map(c => c.arguments), [
        ['[DD owner] lookup failed', { stage, code: '42703' }],
      ]);
    });
  }
}

test('duplicate optional rows are failures, not missing records; arbitrary error codes are redacted', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const f = fixture();
  f.rows.form_submission_due_diligence.push({ ...f.rows.form_submission_due_diligence[0] });
  assert.deepEqual(await f.run(), { ownerName: 'Default Owner', ownerEmail: '' });
  assert.equal(warn.mock.calls[0].arguments[1].code, 'PGRST116');
  f.failures.form_submission_due_diligence = { code: 'private@example.invalid' };
  await f.run();
  assert.equal(warn.mock.calls[1].arguments[1].code, 'UNKNOWN');
});

test('each lookup excludes matching records from another tenant', async () => {
  for (const table of Object.keys(schema)) {
    const f = fixture();
    f.rows[table][0].tenant_id = 'b';
    if (['form_submission', 'form_due_diligence_config'].includes(table)) f.rows.form_submission_due_diligence = [];
    const result = await f.run();
    if (table === 'member') assert.deepEqual(result, { ...assigned, ownerEmail: '' });
    else if (table === 'form_submission_due_diligence') assert.deepEqual(result, { ownerName: 'Default Owner', ownerEmail: '' });
    else assert.deepEqual(result, empty);
    assert.ok(f.calls.every(c => c.filters.tenant_id === 'a'));
  }
  const f = fixture();
  assert.deepEqual(await f.run({ tenantId: 'b', formId: 'form' }), empty);
});

test('missing required lookup context never queries', async () => {
  const f = fixture();
  assert.deepEqual(await f.run({ tenantId: null }), empty);
  assert.deepEqual(await f.run({ formSubmissionId: null }), empty);
  assert.deepEqual(await f.run({ supabase: null }), empty);
  assert.equal(f.calls.length, 0);
});