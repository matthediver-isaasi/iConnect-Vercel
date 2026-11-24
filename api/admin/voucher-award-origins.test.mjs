import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoucherAwardOriginsHandler } from './voucher-award-origins.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1), otherTenant = id(2), org = id(3);
const voucher = (n, extra = {}) => ({ id: id(n), tenant_id: tenant, organization_id: org, member_id: null, ...extra });
const grant = (n, extra = {}) => ({
  id: id(n + 100), tenant_id: tenant, voucher_id: id(n), speaker_id: id(50),
  speaker_name: 'Recorded Speaker', event_type: 'event', event_id: id(60), ...extra,
});

const schema = {
  voucher: ['id', 'organization_id', 'member_id'],
  speaker_award_grant: ['id', 'voucher_id', 'speaker_id', 'speaker_name', 'event_type', 'event_id', 'agenda_snapshot'],
  speaker: ['id', 'full_name'],
  event: ['id', 'title', 'internal_reference'],
  complex_event: ['id', 'title', 'internal_reference'],
};

function setup({ tables = {}, fail, failure = { code: '08006', message: 'Database failure' },
  legacy = false, context = { isAuthenticated: true, tenantId: tenant }, admin = true } = {}) {
  const calls = [];
  const diagnostics = [];
  const db = { from(table) {
    const filters = [];
    let range, selected, call;
    const query = {
      select(fields) { selected = fields.split(',').map(f => f.trim()); call = { table, fields, filters }; calls.push(call); return this; },
      eq(key, value) { filters.push([key, value]); return this; },
      in(key, values) { filters.push([key, values]); return this; },
      order(key, options) { call.order = [key, options]; return this; },
      range(from, to) { range = [from, to]; call.range = range; return this; },
      then(resolve, reject) {
        const columns = schema[table].filter(field => !legacy || field !== 'agenda_snapshot');
        const unknown = selected.find(field => !columns.includes(field));
        if (unknown) return Promise.resolve({ data: null, error: {
          code: '42703', message: `column ${table}.${unknown} does not exist`,
        } }).then(resolve, reject);
        let rows = (tables[table] || []).filter(row => filters.every(([key, value]) =>
          Array.isArray(value) ? value.includes(row[key]) : value === row[key]));
        rows = rows.sort((a, b) => a.id.localeCompare(b.id));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        rows = rows.map(row => Object.fromEntries(selected.map(field => [field, row[field]])));
        return Promise.resolve(table === fail ? { data: null, error: failure } : { data: rows, error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
  const handler = createVoucherAwardOriginsHandler({ db, tenantContext: async () => context, adminAccess: async () => admin,
    diagnostic: context => diagnostics.push(context) });
  const run = async (body = { voucher_ids: [id(10)] }, method = 'POST') => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, body }, res);
    return res;
  };
  return { run, calls, diagnostics };
}

test('existing linked vouchers resolve simple, complex and agenda parent events without writes', async () => {
  const { run, calls } = setup({ tables: {
    voucher: [voucher(10), voucher(11), voucher(12)],
    speaker_award_grant: [
      grant(10), grant(11, { event_type: 'complex_event' }),
      grant(12, { speaker_name: null, agenda_snapshot: { event_title: 'Original parent training', description: 'NOT THE EVENT' } }),
    ],
    speaker: [{ id: id(50), tenant_id: tenant, full_name: 'Source Speaker' }],
    event: [{ id: id(60), tenant_id: tenant, title: 'Simple Event', internal_reference: 'S-123' }],
    complex_event: [{ id: id(60), tenant_id: tenant, title: 'Complex Event', internal_reference: 'C-456' }],
  } });
  const response = await run({ voucher_ids: [id(10), id(11), id(12), id(10)] });
  assert.equal(response.code, 200);
  assert.equal(response.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(response.body.origins, {
    [id(10)]: [{ speaker: 'Recorded Speaker', event: 'Simple Event', event_internal_reference: 'S-123' }],
    [id(11)]: [{ speaker: 'Recorded Speaker', event: 'Complex Event', event_internal_reference: 'C-456' }],
    [id(12)]: [{ speaker: 'Source Speaker', event: 'Original parent training', event_internal_reference: 'S-123' }],
  });
  assert.ok(calls.every(call => call.filters.some(([key, value]) => key === 'tenant_id' && value === tenant)));
  assert.ok(calls.every(call => !call.fields.includes('email')));
});

test('missing sources retain only trustworthy snapshots and never substitute agenda descriptions', async () => {
  const { run } = setup({ tables: {
    voucher: [voucher(10), voucher(11)],
    speaker_award_grant: [grant(10, { agenda_snapshot: { event_title: 'Preserved Event' } }),
      grant(11, { speaker_name: ' ', agenda_snapshot: { description: 'Agenda description' } })],
  } });
  const { body } = await run({ voucher_ids: [id(10), id(11)] });
  assert.deepEqual(body.origins[id(10)], [{ speaker: 'Recorded Speaker', event: 'Preserved Event', event_internal_reference: null }]);
  assert.deepEqual(body.origins[id(11)], [{ speaker: null, event: null, event_internal_reference: null }]);
});

test('unrelated and individual vouchers do not acquire provenance from their code or description', async () => {
  const { run } = setup({ tables: {
    voucher: [voucher(10, { code: 'SPK-LEGACY', description: 'Speaker award — Fake' }),
      voucher(11, { organization_id: null, member_id: id(70) }), voucher(12, { member_id: id(70) })],
    speaker_award_grant: [grant(11), grant(12)],
  } });
  assert.deepEqual((await run({ voucher_ids: [id(10), id(11), id(12)] })).body, { origins: {} });
});

test('tenant isolation applies to voucher, ledger, speaker and both event sources', async () => {
  const { run } = setup({ tables: {
    voucher: [voucher(10), voucher(11, { tenant_id: otherTenant }), voucher(12), voucher(13)],
    speaker_award_grant: [grant(10, { tenant_id: otherTenant }), grant(11),
      grant(12, { speaker_name: null }), grant(13, { speaker_name: null, event_type: 'complex_event' })],
    speaker: [{ id: id(50), tenant_id: otherTenant, full_name: 'SECRET' }],
    event: [{ id: id(60), tenant_id: otherTenant, title: 'SECRET', internal_reference: 'SECRET' }],
    complex_event: [{ id: id(60), tenant_id: otherTenant, title: 'SECRET', internal_reference: 'SECRET' }],
  } });
  const res = await run({ voucher_ids: [id(10), id(11), id(12), id(13)] });
  assert.equal(res.code, 200);
  assert.deepEqual(Object.keys(res.body.origins), [id(12), id(13)]);
  assert.ok(!JSON.stringify(res.body).includes('SECRET'));
});

for (const body of [null, {}, { voucher_ids: [] }, { voucher_ids: 'x' }, { voucher_ids: [null] },
  { voucher_ids: ['not-a-uuid'] }, { voucher_ids: Array(101).fill(id(10)) }]) {
  test(`invalid batch is rejected before querying: ${JSON.stringify(body)}`, async () => {
    const { run, calls } = setup();
    assert.equal((await run(body)).code, 400);
    assert.equal(calls.length, 0);
  });
}

for (const [context, admin, expected] of [
  [null, true, 403], [{ tenantId: tenant, isAuthenticated: false }, true, 403],
  [{ isAuthenticated: true }, true, 403], [{ tenantId: tenant, isAuthenticated: true }, false, 403],
  [{ tenantMismatch: true }, true, 409],
]) {
  test(`unauthorised context is denied: ${JSON.stringify(context)} ${admin}`, async () => {
    const { run, calls } = setup({ context, admin });
    assert.equal((await run()).code, expected);
    assert.equal(calls.length, 0);
  });
}

test('read-only metadata rejects unsupported methods', async () => {
  assert.equal((await setup().run({}, 'GET')).code, 405);
});

for (const fail of ['voucher', 'speaker_award_grant', 'speaker', 'event', 'complex_event']) {
  test(`failure in ${fail} is recoverable, not confirmed absence`, async () => {
    const { run, diagnostics } = setup({ fail, tables: {
      voucher: [voucher(10), voucher(11)],
      speaker_award_grant: [grant(10, { speaker_name: null }), grant(11, { event_type: 'complex_event' })],
    } });
    const res = await run({ voucher_ids: [id(10), id(11)] });
    assert.equal(res.code, 503);
    assert.equal(res.body.origins, undefined);
    assert.deepEqual(diagnostics, [{ stage: fail === 'speaker_award_grant' ? 'grants_snapshot' : fail, code: '08006', outcome: 'failed' }]);
  });
}

test('multiple ledger pages and actual multiple links are preserved', async () => {
  const { run } = setup({ tables: {
    voucher: [voucher(10)],
    speaker_award_grant: Array.from({ length: 201 }, (_, n) => grant(10, { id: id(1000 + n) })),
  } });
  assert.equal((await run()).body.origins[id(10)].length, 201);
});

test('legacy schema preserves paged links, source titles, missing sources and tenant isolation', async () => {
  const { run, calls, diagnostics } = setup({ legacy: true, tables: {
    voucher: [voucher(10), voucher(11, { tenant_id: otherTenant }), voucher(12, { member_id: id(70) })],
    speaker_award_grant: [
      ...Array.from({ length: 201 }, (_, n) => grant(10, {
        id: id(1000 + n), speaker_name: null, event_type: n % 2 ? 'complex_event' : 'event',
        agenda_snapshot: { event_title: 'Must not leak from unselected fixture fields' },
      })),
      grant(10, { id: id(2000), tenant_id: otherTenant, speaker_name: 'SECRET' }),
      grant(11), grant(12),
      grant(10, { id: id(2001), speaker_name: null, speaker_id: id(99), event_id: id(99) }),
    ],
    speaker: [{ id: id(50), tenant_id: tenant, full_name: 'Source Speaker' }],
    event: [{ id: id(60), tenant_id: tenant, title: 'Parent Event', internal_reference: 'E-1' }],
    complex_event: [{ id: id(60), tenant_id: tenant, title: 'Complex Parent', internal_reference: 'C-1' }],
  } });
  const response = await run({ voucher_ids: [id(10), id(11), id(12)] });
  assert.equal(response.code, 200);
  assert.deepEqual(Object.keys(response.body.origins), [id(10)]);
  const origins = response.body.origins[id(10)];
  assert.equal(origins.length, 202);
  assert.deepEqual(origins[0], { speaker: 'Source Speaker', event: 'Parent Event', event_internal_reference: 'E-1' });
  assert.deepEqual(origins[1], { speaker: 'Source Speaker', event: 'Complex Parent', event_internal_reference: 'C-1' });
  assert.deepEqual(origins.at(-1), { speaker: null, event: null, event_internal_reference: null });
  const reads = calls.filter(c => c.table === 'speaker_award_grant');
  assert.deepEqual(reads.map(c => c.range), [[0, 199], [0, 199], [200, 399]]);
  assert.deepEqual(reads.map(c => c.fields.includes('agenda_snapshot')), [true, false, false]);
  assert.ok(reads.every(c => c.order[0] === 'id' && c.order[1].ascending));
  assert.ok(calls.every(c => c.filters.some(([key, value]) => key === 'tenant_id' && value === tenant)));
  assert.deepEqual(diagnostics, [{ stage: 'grants_snapshot', code: '42703', outcome: 'legacy_fallback' }]);
});

for (const failure of [
  { code: '42703', message: 'column speaker_award_grant.speaker_name does not exist' },
  { code: '42703', message: 'column event.agenda_snapshot does not exist' },
  { code: '42501', message: 'column speaker_award_grant.agenda_snapshot does not exist' },
  { code: 'PGRST204', message: 'Unknown schema cache failure agenda_snapshot' },
  { code: '08006', message: 'Private customer details', details: 'SECRET', hint: 'SECRET' },
  { code: 'SECRET customer data', message: 'SECRET' },
]) {
  test(`unrelated grant error stays generic and never falls back: ${failure.code} ${failure.message}`, async () => {
    const { run, calls, diagnostics } = setup({ fail: 'speaker_award_grant', failure, tables: { voucher: [voucher(10)] } });
    assert.deepEqual((await run()).body, { error: 'Unable to load speaker award origins. Please retry.' });
    assert.equal(calls.filter(c => c.table === 'speaker_award_grant').length, 1);
    assert.deepEqual(diagnostics, [{ stage: 'grants_snapshot',
      code: failure.code.includes('SECRET') ? 'UNKNOWN' : failure.code, outcome: 'failed' }]);
  });
}

test('failure of the legacy retry remains an error with safe stage diagnostics', async () => {
  const { run, diagnostics } = setup({ legacy: true, fail: 'speaker_award_grant', tables: { voucher: [voucher(10)] } });
  assert.equal((await run()).code, 503);
  assert.deepEqual(diagnostics, [
    { stage: 'grants_snapshot', code: '42703', outcome: 'legacy_fallback' },
    { stage: 'grants_legacy', code: '08006', outcome: 'failed' },
  ]);
});
