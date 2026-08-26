import assert from 'node:assert/strict';
import test from 'node:test';

import handler from './validate-uniqueness.js';

const TENANT_ID = 'tenant-current';

function createSupabase(memberRows = []) {
  const queriedTables = [];

  return {
    queriedTables,
    from(table) {
      queriedTables.push(table);
      if (table !== 'member' && table !== 'organization') {
        throw new Error(`Unexpected uniqueness lookup against ${table}`);
      }

      const filters = [];
      const query = {
        select() { return query; },
        limit() { return query; },
        eq(column, value) {
          filters.push((row) => row[column] === value);
          return query;
        },
        ilike(column, pattern) {
          const regex = new RegExp(
            `^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('%', '.*')}$`,
            'i',
          );
          filters.push((row) => regex.test(String(row[column] ?? '')));
          return query;
        },
        then(resolve, reject) {
          const rows = memberRows.filter((row) => filters.every((filter) => filter(row)));
          return Promise.resolve({ data: rows.slice(0, 1), error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function validate(memberRows, email, errorMessage = 'Already a member of GSF') {
  const supabaseClient = createSupabase(memberRows);
  const res = createResponse();

  await handler({
    method: 'POST',
    body: {
      form_id: 'a115f8da-e97f-49e6-aaa0-d4cab030e418',
      uniqueness_checks: [{
        field_id: 'email-field',
        target_field: 'member.email',
        comparison_mode: 'equals_lowercase',
        error_message: errorMessage,
      }],
      form_values: { 'email-field': email },
      fields: [{ id: 'email-field', label: 'Email' }],
    },
  }, res, {
    supabaseClient,
    resolveTenantIdFn: async () => TENANT_ID,
  });

  return { res, queriedTables: supabaseClient.queriedTables };
}

test('prior submission history is not consulted for an entity-targeted rule', async () => {
  const { res, queriedTables } = await validate([], 'subscriber@example.com');

  assert.deepEqual(res.body, { valid: true, conflicts: [] });
  assert.deepEqual(queriedTables, ['member']);
});

test('same-tenant member email blocks case-insensitively with the configured message', async () => {
  const { res } = await validate([
    { id: 'member-1', tenant_id: TENANT_ID, email: 'Person@Example.com' },
  ], 'person@example.com', 'This email is already a member');

  assert.equal(res.body.valid, false);
  assert.deepEqual(res.body.conflicts, [{
    field_id: 'email-field',
    field_label: 'Email',
    message: 'This email is already a member',
  }]);
});

test('member email in another tenant does not block submission', async () => {
  const { res } = await validate([
    { id: 'member-other', tenant_id: 'tenant-other', email: 'person@example.com' },
  ], 'PERSON@example.com');

  assert.deepEqual(res.body, { valid: true, conflicts: [] });
});

test('blank custom message uses the member-specific default', async () => {
  const { res } = await validate([
    { id: 'member-1', tenant_id: TENANT_ID, email: 'person@example.com' },
  ], 'person@example.com', '  ');

  assert.match(res.body.conflicts[0].message, /a member registered with this value/i);
});
