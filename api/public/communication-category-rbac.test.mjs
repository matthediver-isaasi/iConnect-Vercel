import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { applyPublicCommunicationSubscription } from './subscribe.js';

function createDatabase({ category, member = null } = {}) {
  const writes = [];
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = {};
    }
    select() { return this; }
    eq(column, value) { this.filters[column] = value; return this; }
    maybeSingle() {
      if (this.table === 'communication_category') {
        const matches = category
          && category.id === this.filters.id
          && category.tenant_id === this.filters.tenant_id;
        return Promise.resolve({ data: matches ? category : null, error: null });
      }
      if (this.table === 'member') {
        const matches = member
          && member.tenant_id === this.filters.tenant_id
          && member.email === this.filters.email;
        return Promise.resolve({ data: matches ? member : null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }
    upsert(values) {
      writes.push({ table: this.table, values });
      return Promise.resolve({ error: null });
    }
  }
  return {
    database: { from: (table) => new Query(table) },
    writes,
  };
}

const publicCategory = {
  id: 'category-1',
  tenant_id: 'tenant-1',
  name: 'News',
  is_active: true,
  is_public: true,
  member_enabled: true,
};

async function subscribe(database, overrides = {}) {
  return applyPublicCommunicationSubscription({
    database,
    tenantId: 'tenant-1',
    email: 'member@example.com',
    categoryId: 'category-1',
    ...overrides,
  });
}

test('public category subscribes a member whose role is allowed', async () => {
  const { database, writes } = createDatabase({
    category: publicCategory,
    member: { id: 'member-1', tenant_id: 'tenant-1', email: 'member@example.com', role_id: 'role-1' },
  });
  const result = await subscribe(database, {
    eligibilityLoader: async () => ({ eligibleCategoryIds: new Set(['category-1']) }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.subscriberType, 'member');
  assert.deepEqual(writes.map(({ table }) => table), ['member_communication_preference']);
  assert.equal(writes[0].values.is_subscribed, true);
});

test('public status does not let a disallowed member subscribe', async () => {
  const { database, writes } = createDatabase({
    category: publicCategory,
    member: { id: 'member-1', tenant_id: 'tenant-1', email: 'member@example.com', role_id: 'role-other' },
  });
  const result = await subscribe(database, {
    eligibilityLoader: async () => ({ eligibleCategoryIds: new Set() }),
  });

  assert.equal(result.status, 403);
  assert.deepEqual(writes, []);
});

test('public-only category rejects a known member but accepts a genuine external subscriber', async () => {
  const category = { ...publicCategory, member_enabled: false };
  const known = createDatabase({
    category,
    member: { id: 'member-1', tenant_id: 'tenant-1', email: 'member@example.com', role_id: 'role-1' },
  });
  const memberResult = await subscribe(known.database, {
    eligibilityLoader: async () => ({ eligibleCategoryIds: new Set() }),
  });
  assert.equal(memberResult.status, 403);
  assert.deepEqual(known.writes, []);

  const external = createDatabase({ category });
  const externalResult = await subscribe(external.database, { email: 'external@example.com' });
  assert.equal(externalResult.status, 200);
  assert.equal(externalResult.subscriberType, 'external');
  assert.deepEqual(external.writes.map(({ table }) => table), ['email_subscriber']);
});

test('roleless public category accepts a member with no assigned role', async () => {
  const { database, writes } = createDatabase({
    category: publicCategory,
    member: { id: 'member-1', tenant_id: 'tenant-1', email: 'member@example.com', role_id: null },
  });
  const result = await subscribe(database, {
    eligibilityLoader: async () => ({ eligibleCategoryIds: new Set(['category-1']) }),
  });

  assert.equal(result.status, 200);
  assert.equal(writes[0].table, 'member_communication_preference');
});

test('private category rejects public subscription before either subscriber path writes', async () => {
  const { database, writes } = createDatabase({
    category: { ...publicCategory, is_public: false },
  });
  const result = await subscribe(database);

  assert.equal(result.status, 403);
  assert.deepEqual(writes, []);
});

test('genuine non-member on a public category is stored only as an external subscriber', async () => {
  const { database, writes } = createDatabase({ category: publicCategory });
  const result = await subscribe(database, {
    email: ' External@Example.com ',
    firstName: 'Ada',
    lastName: 'Lovelace',
  });

  assert.equal(result.status, 200);
  assert.equal(result.subscriberType, 'external');
  assert.deepEqual(writes.map(({ table }) => table), ['email_subscriber']);
  assert.equal(writes[0].values.email, 'external@example.com');
});

test('category tenant mismatch is not discoverable through public subscription', async () => {
  const { database, writes } = createDatabase({
    category: { ...publicCategory, tenant_id: 'tenant-2' },
  });
  const result = await subscribe(database);

  assert.equal(result.status, 404);
  assert.deepEqual(writes, []);
});

test('donation booking member opt-in is gated before its preference write', async () => {
  const source = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../functions/[functionName].js'),
    'utf8',
  );
  const bookingStart = source.indexOf('// Subscribe donor to email communication list');
  const bookingEnd = source.indexOf('// Calculate total used across all vouchers', bookingStart);
  const block = source.slice(bookingStart, bookingEnd);
  const eligibilityAt = block.indexOf('loadMemberCommunicationCategoryEligibility');
  const eligibilityCheckAt = block.indexOf('eligibleCategoryIds.has(emailListCategoryId)');
  const firstPreferenceWriteAt = block.indexOf(".from('member_communication_preference')");

  assert.ok(eligibilityAt >= 0, 'donation member opt-in must load shared eligibility');
  assert.ok(eligibilityCheckAt > eligibilityAt, 'donation member opt-in must check the configured category');
  assert.ok(
    firstPreferenceWriteAt > eligibilityCheckAt,
    'donation member preference access must occur only after the role check',
  );
  const guestStart = block.indexOf('Guest booking - subscribing');
  const guestBlock = block.slice(guestStart);
  assert.match(guestBlock, /\.eq\('is_active', true\)/);
  assert.match(guestBlock, /\.eq\('is_public', true\)/);
  assert.ok(
    guestBlock.indexOf(".eq('is_public', true)") < guestBlock.indexOf(".from('email_subscriber')"),
    'guest donation subscription must require a public category before writing',
  );
});