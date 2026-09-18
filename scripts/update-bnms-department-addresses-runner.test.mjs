import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OBJECT_ID,
  PHONE_ID,
  TENANT_ID,
} from './lib/bnms-department-address-plan.mjs';
import {
  applyChanges,
  assertFresh,
  preservation,
  readAll,
} from './update-bnms-department-addresses.mjs';

const RECORD_ID = '10000000-0000-0000-0000-000000000001';

function field(name, overrides = {}) {
  return {
    id: name === 'phone_number' ? PHONE_ID : `field-${name}`,
    tenant_id: TENANT_ID,
    custom_object_id: OBJECT_ID,
    entity_scope: 'custom_object',
    name,
    label: name,
    field_type: 'text',
    is_active: true,
    is_required: false,
    archived_at: null,
    ...overrides,
  };
}

function applyFixture() {
  const before = {
    id: RECORD_ID,
    tenant_id: TENANT_ID,
    custom_object_id: OBJECT_ID,
    archived_at: null,
    data: { name: 'Department', address_line_1: 'Old', untouched: 'keep' },
    updated_at: '2026-09-17T10:00:00.123456Z',
    updated_by: 'previous',
  };
  return {
    before,
    state: {
      fields: [
        field('address_line_1', { max_length: 30 }),
        field('phone_number'),
      ],
      records: [before],
    },
    plan: {
      blockers: [],
      phoneChange: { required: false },
      items: [{
        recordId: RECORD_ID,
        sourceRow: 2,
        diffs: [{ key: 'address_line_1', before: 'Old', after: 'New' }],
        patch: { address_line_1: 'New' },
        afterData: { ...before.data, address_line_1: 'New' },
      }],
    },
  };
}

test('readAll keyset-paginates beyond 500 rows and verifies the complete count', async () => {
  const rows = Array.from({ length: 503 }, (_, index) => ({
    id: `10000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    value: index,
  }));
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ n: rows.length }] };
      const cursor = params.at(-1);
      return {
        rows: rows.filter((row) => row.id > cursor).slice(0, 500).map((row) => ({ row })),
      };
    },
  };

  const actual = await readAll(client, 'organization', 't.tenant_id=$1', [TENANT_ID], true);

  assert.deepEqual(actual, rows);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].params[1], '00000000-0000-0000-0000-000000000000');
  assert.equal(calls[1].params[1], rows[499].id);
  assert.match(calls[0].sql, /ORDER BY t\.id LIMIT 500 FOR UPDATE OF t/);
  assert.deepEqual(calls[2].params, [TENANT_ID]);
});

test('readAll rejects incomplete counts and unapproved tables', async () => {
  const client = {
    async query(sql) {
      return sql.startsWith('SELECT count(*)')
        ? { rows: [{ n: 2 }] }
        : { rows: [{ row: { id: RECORD_ID } }] };
    },
  };
  await assert.rejects(
    readAll(client, 'organization', 'true', []),
    /Incomplete or duplicate pagination: organization/,
  );
  await assert.rejects(readAll(client, 'users', 'true', []), /Unapproved table/);
});

test('assertFresh rejects a changed snapshot, including exact timestamp changes', () => {
  const snapshot = {
    id: RECORD_ID,
    data: { address_line_1: 'One' },
    updated_at: '2026-09-17T10:00:00.123456Z',
  };
  assert.doesNotThrow(() => assertFresh(snapshot, structuredClone(snapshot)));
  assert.throws(
    () => assertFresh(snapshot, { ...snapshot, data: { address_line_1: 'Two' } }),
    /Stale preflight/,
  );
  assert.throws(
    () => assertFresh(snapshot, { ...snapshot, updated_at: '2026-09-17T10:00:00.123457Z' }),
    /Stale preflight/,
  );
});

test('preservation fingerprints every table and scopes only permitted exclusions', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ count: 1, hash: `hash-${calls.length}` }] };
    },
  };
  const items = [
    {
      recordId: RECORD_ID,
      diffs: [{ key: 'address_line_1' }],
      patch: { address_line_1: 'New' },
    },
    {
      recordId: '10000000-0000-0000-0000-000000000002',
      diffs: [],
      patch: {},
    },
  ];

  const result = await preservation(client, items, true);

  assert.equal(calls.length, 7);
  assert.equal(Object.keys(result).length, 7);
  const recordCall = calls.find(({ sql }) => sql.includes('custom_object_record'));
  assert.match(recordCall.sql, /t\.id=ANY\(\$1::uuid\[\]\)/);
  assert.match(recordCall.sql, /to_jsonb\(t\)-'updated_at'-'updated_by'-'data'/);
  assert.deepEqual(recordCall.params[0], [RECORD_ID]);
  assert.deepEqual(JSON.parse(recordCall.params[1]), {
    [RECORD_ID]: ['address_line_1'],
    '10000000-0000-0000-0000-000000000002': [],
  });
  const phoneCall = calls.find(({ sql }) => sql.includes('preference_field'));
  assert.match(phoneCall.sql, /t\.id=\$1/);
  assert.match(phoneCall.sql, /-'field_type'-'updated_at'-'updated_by'/);
  assert.deepEqual(phoneCall.params, [PHONE_ID]);
  for (const call of calls.filter(({ sql }) => (
    !sql.includes('custom_object_record') && !sql.includes('preference_field')
  ))) {
    assert.match(call.sql, /md5\(\(to_jsonb\(t\)\)::text\)/);
    assert.deepEqual(call.params, []);
  }
});

test('applyChanges uses domain validation plus tenant-scoped full-row CAS updates', async () => {
  const { before, state, plan } = applyFixture();
  state.fields[1] = field('phone_number', { field_type: 'number' });
  plan.phoneChange = { required: true };
  plan.phoneField = structuredClone(state.fields[1]);
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [{ id: params[0] }] };
    },
  };

  assert.equal(await applyChanges(client, state, plan), 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /WHERE id=\$1 AND tenant_id=\$2 AND custom_object_id=\$3 AND field_type='number'/);
  assert.match(calls[0].sql, /AND to_jsonb\(f\)=\$5::jsonb/);
  assert.deepEqual(calls[0].params.slice(0, 3), [PHONE_ID, TENANT_ID, OBJECT_ID]);
  assert.deepEqual(JSON.parse(calls[0].params[4]), plan.phoneField);
  assert.match(calls[1].sql, /WHERE id=\$1 AND tenant_id=\$2 AND custom_object_id=\$3 AND archived_at IS NULL/);
  assert.match(calls[1].sql, /AND to_jsonb\(r\)=\$6::jsonb/);
  assert.deepEqual(calls[1].params.slice(0, 3), [RECORD_ID, TENANT_ID, OBJECT_ID]);
  assert.deepEqual(JSON.parse(calls[1].params[3]), plan.items[0].patch);
  assert.deepEqual(JSON.parse(calls[1].params[5]), before);

  const invalid = applyFixture();
  invalid.plan.items[0].patch.address_line_1 = 'x'.repeat(31);
  invalid.plan.items[0].afterData.address_line_1 = 'x'.repeat(31);
  await assert.rejects(
    applyChanges({ query: async () => assert.fail('invalid data must not be written') },
      invalid.state, invalid.plan),
    /Record validation changed for source row 2/,
  );
});

test('applyChanges blocks blank and unallowed patch keys before writing', async () => {
  for (const patch of [
    { address_line_1: '   ' },
    { not_an_address_field: 'value' },
  ]) {
    const fixture = applyFixture();
    fixture.plan.items[0].patch = patch;
    await assert.rejects(
      applyChanges({ query: async () => assert.fail('forbidden patch must not be written') },
        fixture.state, fixture.plan),
      /Forbidden or blank patch at row 2/,
    );
  }
});

test('applyChanges rejects cross-tenant records and stale CAS results', async () => {
  const foreign = applyFixture();
  foreign.before.tenant_id = '00000000-0000-0000-0000-000000000999';
  await assert.rejects(
    applyChanges({ query: async () => assert.fail('foreign record must not be written') },
      foreign.state, foreign.plan),
    /Record ownership\/lifecycle mismatch/,
  );

  const stale = applyFixture();
  await assert.rejects(
    applyChanges({ query: async () => ({ rowCount: 0, rows: [] }) }, stale.state, stale.plan),
    /Stale Department for source row 2/,
  );
});

test('applyChanges performs no writes for an unchanged plan', async () => {
  const { state, plan } = applyFixture();
  plan.items[0].diffs = [];
  plan.items[0].patch = {};
  plan.items[0].afterData = structuredClone(state.records[0].data);
  let writes = 0;
  const updated = await applyChanges({
    async query() {
      writes++;
      return { rowCount: 1 };
    },
  }, state, plan);
  assert.equal(updated, 0);
  assert.equal(writes, 0);
});