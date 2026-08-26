import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeLikeLiteral,
  loadExternalSubscriberPreferences,
  optOutExternalAll,
  optOutExternalCategory,
} from './externalSubscriberPreferences.js';

function matchesIlike(value, pattern) {
  let regex = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\' && index + 1 < pattern.length) {
      index += 1;
      regex += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (character === '%') {
      regex += '.*';
    } else if (character === '_') {
      regex += '.';
    } else {
      regex += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${regex}$`, 'i').test(String(value));
}

function createDb({ subscribers = [], unsubscribes = [] } = {}) {
  const writes = [];
  const calls = [];

  function builder(table) {
    const filters = [];
    let operation = 'select';
    let payload;
    const query = {
      select() { operation = 'select'; return query; },
      update(value) { operation = 'update'; payload = value; return query; },
      insert(value) { operation = 'insert'; payload = value; return query; },
      upsert(value) { operation = 'upsert'; payload = value; return query; },
      eq(column, value) { filters.push(['eq', column, value]); return query; },
      ilike(column, value) { filters.push(['ilike', column, value]); return query; },
      in(column, value) { filters.push(['in', column, value]); return query; },
      is(column, value) { filters.push(['eq', column, value]); return query; },
      then(resolve, reject) {
        try {
          calls.push({ table, operation, filters: [...filters] });
          if (operation !== 'select') {
            writes.push({ table, operation, payload, filters: [...filters] });
            return Promise.resolve(resolve({ data: null, error: null }));
          }
          let rows = table === 'email_subscriber' ? subscribers : unsubscribes;
          rows = rows.filter((row) => filters.every(([kind, column, value]) => {
            if (kind === 'eq') return row[column] === value;
            if (kind === 'in') return value.includes(row[column]);
            return matchesIlike(row[column], value);
          }));
          return Promise.resolve(resolve({ data: rows, error: null }));
        } catch (error) {
          return reject ? Promise.resolve(reject(error)) : Promise.reject(error);
        }
      },
    };
    return query;
  }

  return { db: { from: builder }, writes, calls };
}

test('discovers only active tenant categories with case-insensitive email matches and does not write', async () => {
  const { db, writes, calls } = createDb({
    subscribers: [
      { id: 's1', tenant_id: 't1', email: 'Person@Example.COM', communication_category_id: 'c1', opted_out: false },
      { id: 's2', tenant_id: 't1', email: 'person@example.com', communication_category_id: 'c2', opted_out: true },
      { id: 's3', tenant_id: 't2', email: 'person@example.com', communication_category_id: 'c3', opted_out: false },
    ],
    unsubscribes: [
      { tenant_id: 't1', email: 'PERSON@example.com', unsubscribe_type: 'category', communication_category_id: 'c2' },
    ],
  });
  const result = await loadExternalSubscriberPreferences(db, {
    tenantId: 't1',
    email: ' Person@Example.com ',
    activeCategories: [
      { id: 'c1', name: 'News' },
      { id: 'c2', name: 'Events' },
      { id: 'c3', name: 'Other tenant' },
      { id: 'c4', name: 'Never subscribed' },
    ],
  });

  assert.deepEqual(result.categories.map(({ id, isSubscribed }) => ({ id, isSubscribed })), [
    { id: 'c1', isSubscribed: true },
    { id: 'c2', isSubscribed: false },
  ]);
  assert.equal(result.normalizedEmail, 'person@example.com');
  assert.equal(writes.length, 0);
  assert.ok(calls.every((call) => call.operation === 'select'));
});

test('escapes wildcard characters before case-insensitive email matching', async () => {
  assert.equal(escapeLikeLiteral('person_100%@example.com'), 'person\\_100\\%@example.com');
  const { db, calls } = createDb({
    subscribers: [
      { id: 'target', tenant_id: 't1', email: 'Person_100%@Example.com', communication_category_id: 'c1', opted_out: false },
      { id: 'other', tenant_id: 't1', email: 'personA100X@example.com', communication_category_id: 'c2', opted_out: false },
    ],
  });
  const result = await loadExternalSubscriberPreferences(db, {
    tenantId: 't1',
    email: 'Person_100%@Example.com',
    activeCategories: [{ id: 'c1' }, { id: 'c2' }],
  });
  assert.deepEqual(result.categories.map((category) => category.id), ['c1']);
  const emailFilters = calls.flatMap((call) => call.filters)
    .filter(([kind, column]) => kind === 'ilike' && column === 'email');
  assert.deepEqual(emailFilters, [
    ['ilike', 'email', 'person\\_100\\%@example.com'],
    ['ilike', 'email', 'person\\_100\\%@example.com'],
  ]);
});

test('category opt-out updates only matching subscription rows and records category ledger', async () => {
  const { db, writes } = createDb({
    subscribers: [
      { id: 's1', tenant_id: 't1', email: 'Person@Example.com', communication_category_id: 'c1' },
      { id: 's2', tenant_id: 't1', email: 'person@example.com', communication_category_id: 'c2' },
    ],
  });
  const result = await optOutExternalCategory(db, {
    tenantId: 't1',
    email: 'PERSON@example.com',
    categoryId: 'c1',
    campaignId: 'campaign-1',
  });

  assert.equal(result.found, true);
  const subscriberWrite = writes.find((write) => write.table === 'email_subscriber');
  assert.deepEqual(subscriberWrite.filters, [['in', 'id', ['s1']]]);
  assert.equal(subscriberWrite.payload.opted_out, true);
  const ledgerWrite = writes.find((write) => write.table === 'email_unsubscribe');
  assert.equal(ledgerWrite.payload.unsubscribe_type, 'category');
  assert.equal(ledgerWrite.payload.communication_category_id, 'c1');
  assert.equal(ledgerWrite.payload.email, 'person@example.com');
});

test('global opt-out updates all normalized-email subscriber rows and records global ledger', async () => {
  const { db, writes } = createDb();
  await optOutExternalAll(db, {
    tenantId: 't1',
    email: ' PERSON@Example.com ',
    campaignId: 'campaign-1',
  });

  const subscriberWrite = writes.find((write) => write.table === 'email_subscriber');
  assert.ok(subscriberWrite.filters.some((filter) => (
    filter[0] === 'ilike' && filter[1] === 'email' && filter[2] === 'person@example.com'
  )));
  const ledgerWrite = writes.find((write) => write.table === 'email_unsubscribe');
  assert.equal(ledgerWrite.payload.unsubscribe_type, 'all');
  assert.equal(ledgerWrite.payload.communication_category_id, null);
  assert.equal(ledgerWrite.payload.email, 'person@example.com');
});