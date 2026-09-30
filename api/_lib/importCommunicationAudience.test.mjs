import assert from 'node:assert/strict';
import test from 'node:test';
import { filterImportCommunicationPreferences } from './importProcessor.js';

function createDatabase({ categories, assignments = [], members, failures = {} }) {
  const rowsByTable = {
    communication_category: categories,
    communication_category_role: assignments,
    member: members,
  };
  return {
    from(table) {
      const filters = {};
      const query = {
        select() { return query; },
        eq(column, value) { filters[column] = value; return query; },
        in(column, values) { filters[column] = values; return query; },
        then(resolve) {
          const data = (rowsByTable[table] || []).filter((row) =>
            Object.entries(filters).every(([key, value]) =>
              Array.isArray(value) ? value.includes(row[key]) : row[key] === value
            )
          );
          return Promise.resolve({ data, error: failures[table] || null }).then(resolve);
        },
      };
      return query;
    },
  };
}

const rows = [
  { tenant_id: 'tenant-1', member_id: 'member-a', category_id: 'members-open', is_subscribed: true },
  { tenant_id: 'tenant-1', member_id: 'member-a', category_id: 'members-role', is_subscribed: true },
  { tenant_id: 'tenant-1', member_id: 'member-a', category_id: 'public-only', is_subscribed: true },
  { tenant_id: 'tenant-1', member_id: 'member-a', category_id: 'public-only', is_subscribed: false },
];

test('member imports allow member-enabled eligible opt-ins and retain public-only opt-outs', async () => {
  const database = createDatabase({
    categories: [
      { id: 'members-open', tenant_id: 'tenant-1', member_enabled: true },
      { id: 'members-role', tenant_id: 'tenant-1', member_enabled: true },
      { id: 'public-only', tenant_id: 'tenant-1', member_enabled: false },
    ],
    assignments: [
      { tenant_id: 'tenant-1', category_id: 'members-role', role_id: 'role-a' },
    ],
    members: [{ id: 'member-a', tenant_id: 'tenant-1', role_id: 'role-a' }],
  });

  const result = await filterImportCommunicationPreferences(database, 'tenant-1', rows);
  assert.deepEqual(
    result.map(({ category_id, is_subscribed }) => [category_id, is_subscribed]),
    [
      ['members-open', true],
      ['members-role', true],
      ['public-only', false],
    ],
  );
});

test('member imports reject role-restricted opt-ins for a nonmatching member', async () => {
  const database = createDatabase({
    categories: [{ id: 'members-role', tenant_id: 'tenant-1', member_enabled: true }],
    assignments: [{ tenant_id: 'tenant-1', category_id: 'members-role', role_id: 'role-a' }],
    members: [{ id: 'member-a', tenant_id: 'tenant-1', role_id: 'role-b' }],
  });

  const result = await filterImportCommunicationPreferences(database, 'tenant-1', [
    { member_id: 'member-a', category_id: 'members-role', is_subscribed: true },
    { member_id: 'member-a', category_id: 'members-role', is_subscribed: false },
  ]);
  assert.deepEqual(result.map(({ is_subscribed }) => is_subscribed), [false]);
});

test('member import eligibility failures fail closed for opt-ins but keep opt-outs safe', async () => {
  const database = createDatabase({
    categories: [],
    members: [],
    failures: { communication_category: { message: 'lookup failed' } },
  });
  const result = await filterImportCommunicationPreferences(database, 'tenant-1', rows);
  assert.deepEqual(result.map(({ is_subscribed }) => is_subscribed), [false]);
});