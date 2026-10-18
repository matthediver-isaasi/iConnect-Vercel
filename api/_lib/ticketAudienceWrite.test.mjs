import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTicketAudienceWrite as validate } from './ticketAudienceWrite.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const first = 'aaaaaaaa-0000-4000-8000-000000000002';
const second = '00000000-0000-4000-8000-000000000003';
const parent = '00000000-0000-4000-8000-000000000004';
const selected = {
  audience_mode: 'selected_members', selected_member_ids: [first], visibility_mode: 'members_only',
};
function database(ids = [first, second], error = null) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.ok(['member','complex_event'].includes(table));
      const query = {
        select(fields) { assert.equal(fields, 'id'); return query; },
        eq(field, value) { calls.push([field, value]); return query; },
        async maybeSingle() { return { data: { id: parent }, error: null }; },
        async in(field, values) {
          calls.push([field, values]);
          return { data: ids.filter(id => values.includes(id)).map(id => ({ id })), error };
        },
      };
      return query;
    },
  };
}
const write = (body, options = {}) => validate({
  db: database(), tenantId, entity: 'ComplexEventTicketClass', body, existingRow: { complex_event_id: parent }, ...options,
});
const invalid = promise => assert.rejects(promise, error => error.status === 400 && error.statusCode === 400);

test('legacy writes remain byte-shape compatible; no member lookup/backfill', async () => {
  for (const body of [
    { name: 'Existing' }, { audience_mode: null }, { audience_mode: 'legacy' },
    { selected_member_ids: null }, { role_ids: ['legacy-role'], role_match_only: true },
  ]) {
    const db = database();
    const result = await write(body, { db });
    const expected = Object.hasOwn(body, 'audience_mode') ? { ...body, selected_member_ids: [] } : body;
    assert.deepEqual(result, expected);
    assert.equal(db.calls.length, 0);
  }
});

test('canonical tenant membership, UUID case and duplicates', async () => {
  const db = database();
  const body = { ...selected, selected_member_ids: [first.toUpperCase(), first, second] };
  assert.deepEqual((await write(body, { db })).selected_member_ids, [first, second]);
  assert.deepEqual(body.selected_member_ids, [first.toUpperCase(), first, second]);
  assert.deepEqual(db.calls[0], ['tenant_id', tenantId]);
  await invalid(write(selected, { db: database([]) }));
  await invalid(write(selected, { db: database([], { message: 'unavailable' }) }));
  await invalid(write(selected, { tenantId: null }));
  await invalid(write(selected, { body: { ...selected, tenant_id: second } }));
  await invalid(write(selected, { existingRow: { tenant_id: second } }));
});

test('invalid mode, array and identity inputs fail closed', async () => {
  for (const body of [
    { ...selected, audience_mode: 'everyone' },
    { ...selected, audience_mode: 1 },
    { ...selected, selected_member_ids: null },
    { ...selected, selected_member_ids: 'not-an-array' },
    { ...selected, selected_member_ids: [null] },
    { ...selected, selected_member_ids: ['not-a-uuid'] },
    { selected_member_ids: [first] },
  ]) await invalid(write(body));
});

test('selected audience rejects every legacy restriction and public/contact policy', async () => {
  for (const conflict of [
    { role_ids: [first] }, { member_group_ids: [first] }, { role_ids: 'bad' },
    { role_match_only: true }, { role_match_only: 'false' },
    { visibility_mode: 'public_only' }, { visibility_mode: 'members_and_public' },
    { visibility_mode: 'public' }, { visibility_mode: null },
    { create_member_records: true }, { create_member_records: 'false' }, { new_member_role_id: first },
  ]) await invalid(write({ ...selected, ...conflict }));
  await write({ ...selected, role_ids: [], member_group_ids: [], role_match_only: false,
    create_member_records: false, new_member_role_id: null });
  const db = database();
  assert.deepEqual((await write({ ...selected, selected_member_ids: [] }, { db })).selected_member_ids, []);
  assert.equal(db.calls.length, 0);
  await invalid(write({ ...selected, selected_member_ids: [], visibility_mode: 'public_only' }));
});

test('PATCH validates merged state and persists normalized IDs; explicit switch clears', async () => {
  const existingRow = { ...selected, selected_member_ids: [first.toUpperCase(), first] };
  assert.deepEqual(await write({ name: 'Renamed' }, { existingRow }), {
    name: 'Renamed', selected_member_ids: [first],
  });
  await invalid(write({ visibility_mode: 'public_only' }, { existingRow }));
  await invalid(write({ audience_mode: 'selected_members', selected_member_ids: [first] }, {
    existingRow: { role_ids: [first], visibility_mode: 'members_only' },
  }));
  for (const audience_mode of ['legacy', null]) {
    assert.deepEqual(await write({ audience_mode }, { existingRow }), { audience_mode, selected_member_ids: [] });
  }
  await write({ audience_mode: 'selected_members', visibility_mode: 'members_only' }, {
    existingRow: { audience_mode: 'legacy', selected_member_ids: [] },
  });
});

test('simple object/string JSON replacement semantics and retained selected state', async () => {
  for (const stringify of [value => value, JSON.stringify]) {
    const input = { ticket_classes: [{ ...selected, selected_member_ids: [first, first.toUpperCase()] }], currency: 'GBP' };
    const result = await write({ pricing_config: stringify(input) }, { entity: 'Event' });
    const config = typeof result.pricing_config === 'string' ? JSON.parse(result.pricing_config) : result.pricing_config;
    assert.deepEqual(config.ticket_classes[0].selected_member_ids, [first]);
    assert.equal(config.currency, 'GBP');
  }
  const existingRow = { pricing_config: { ticket_classes: [selected] } };
  await invalid(write({ name: 'Renamed' }, {
    entity: 'event', existingRow, db: database([]),
  }));
  // A supplied JSON value replaces, never merges hidden old restrictions.
  await write({ pricing_config: { ticket_classes: [selected] } }, {
    entity: 'event', existingRow: { pricing_config: { ticket_classes: [{ ...selected, role_ids: [first] }] } },
  });
  const cleared = await write({ pricing_config: { ticket_classes: [{ ...selected, audience_mode: 'legacy' }] } }, { entity: 'event' });
  assert.deepEqual(cleared.pricing_config.ticket_classes[0].selected_member_ids, []);
  for (const pricing_config of ['{bad', '[]', 42, [], { ticket_classes: {} }, { ticket_classes: [null] }]) {
    await invalid(write({ pricing_config }, { entity: 'event' }));
  }
  for (const pricing_config of [null, '', 'null', {}]) {
    await write({ pricing_config }, { entity: 'event' });
  }
});

test('unrelated entities bypass, bulk selected writes validate all records', async () => {
  const body = { audience_mode: 'invalid' };
  assert.equal(await write(body, { entity: 'Member' }), body);
  assert.equal((await write([{ ...selected, complex_event_id: parent }, { ...selected, complex_event_id: parent }])).length, 2);
  await invalid(write([{ ...selected, complex_event_id: parent }, { ...selected, complex_event_id: parent, selected_member_ids: [tenantId] }]));
});

test('complex parent ownership on create and immutable parent on PATCH', async () => {
  const db = database();
  await write({ ...selected, complex_event_id: parent }, { db, existingRow: null });
  assert.deepEqual(db.calls.slice(0, 2), [['tenant_id', tenantId], ['id', parent]]);
  await invalid(write(selected, { existingRow: null }));
  await invalid(write({ ...selected, complex_event_id: 'bad' }, { existingRow: null }));
  await invalid(write({ complex_event_id: second }));
  await write({ complex_event_id: parent });
  const missing = { from() { const q = { select() { return q; }, eq() { return q; },
    async maybeSingle() { return { data: null, error: null }; } }; return q; } };
  await invalid(write({ ...selected, complex_event_id: parent }, { db: missing, existingRow: null }));
});
