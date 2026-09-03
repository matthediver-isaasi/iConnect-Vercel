import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validatePaymentRelationships } from './form-payment.js';

test('paid create, monthly-card, and quote paths validate repeatable rows before charge resolution', async () => {
  const source = await readFile(new URL('./form-payment.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ validateRepeatableRowSubmission \} from '\.\.\/_lib\/formRepeatableRowValidation\.js';/);
  const quoteStart = source.indexOf('async function handleQuote');
  const monthlyStart = source.indexOf('async function handleCreateMonthlyCard');
  const createStart = source.indexOf('async function handleCreate(');
  const nextFunctionStart = (start) => {
    const next = source.indexOf('\nasync function ', start + 1);
    return next < 0 ? source.length : next;
  };
  for (const start of [quoteStart, monthlyStart, createStart]) {
    const section = source.slice(start, nextFunctionStart(start));
    const validation = section.indexOf('validatePaymentRelationships(');
    const charge = section.indexOf('resolvePayableCharge(');
    assert.ok(validation >= 0, 'payment path validates selections');
    assert.ok(charge < 0 || validation < charge, 'validation occurs before payable charge resolution');
  }
});

test('paid paths reuse one LMIC visibility context for validation and charge resolution', async () => {
  const source = await readFile(new URL('./form-payment.js', import.meta.url), 'utf8');
  for (const name of ['handleQuote', 'handleCreateMonthlyCard', 'handleCreate']) {
    const start = source.indexOf(`async function ${name}`);
    const end = source.indexOf('\nasync function ', start + 1);
    const section = source.slice(start, end < 0 ? source.length : end);
    assert.match(
      section,
      /validatePaymentRelationships\([\s\S]*?evalOptions,[\s\S]*?\)/,
      `${name} passes its visibility context to selection validation`,
    );
    assert.match(
      section,
      /resolvePayableCharge\(\{[\s\S]*?evalOptions[\s\S]*?\}\)/,
      `${name} passes the same visibility context to charge resolution`,
    );
  }
});

test('paid validation rejects repeatable tampering before ordinary relationship database lookups', async () => {
  let queries = 0;
  const response = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  const form = {
    id: 'paid-form',
    fields: [{
      id: 'workplaces', type: 'repeatable_rows',
      child_fields: [{ id: 'organisation', type: 'organisation_dropdown', required: true }],
    }],
  };
  const valid = await validatePaymentRelationships(
    response,
    { from() { queries += 1; throw new Error('must not query for tampered rows'); } },
    { id: 'tenant-1' },
    form,
    { workplaces: [{ organisation: 'org-1', forged: 'yes' }] },
  );
  assert.equal(valid, false);
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.code, 'unknown_child');
  assert.equal(queries, 0);
});

test('paid validation ignores an initialized invalid repeatable row hidden by persisted logic', async () => {
  const response = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  const form = {
    id: 'paid-form',
    fields: [
      { id: 'kind', type: 'text' },
      {
        id: 'workplaces',
        type: 'repeatable_rows',
        child_fields: [{ id: 'organisation', type: 'text', required: true }],
      },
    ],
    visibility_rules: [{
      trigger_field_id: 'kind',
      operator: 'equals',
      value: 'none',
      action: 'hide',
      target_field_ids: ['workplaces'],
    }],
  };
  const valid = await validatePaymentRelationships(
    response,
    { from() { throw new Error('hidden row must not query'); } },
    { id: 'tenant-1' },
    form,
    { kind: 'none', workplaces: [{ organisation: '' }] },
  );
  assert.equal(valid, true);
  assert.equal(response.statusCode, null);
});

test('paid validation rejects an incomplete required address before provider work', async () => {
  const response = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  const form = {
    id: 'paid-form',
    fields: [{
      id: 'address',
      type: 'address_lookup',
      required: true,
      visible_components: ['line_1', 'post_town', 'postcode', 'country'],
      required_components: ['line_1', 'post_town', 'postcode', 'country'],
    }],
  };
  const valid = await validatePaymentRelationships(
    response,
    { from() { throw new Error('invalid address must fail before database/provider work'); } },
    { id: 'tenant-1' },
    form,
    { address: { line_1: '1 Road', postcode: 'AB1 2CD' } },
  );
  assert.equal(valid, false);
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.code, 'ADDRESS_COMPONENTS_REQUIRED');
  assert.deepEqual(response.payload.fields, ['address']);
});

test('provider discovery validates payment purpose and selects matching Stripe credentials', async () => {
  const source = await readFile(new URL('./form-payment-providers.js', import.meta.url), 'utf8');
  assert.match(source, /const purpose = req\.query\?\.purpose \|\| 'forms'/);
  assert.match(source, /!\['forms', 'membership'\]\.includes\(purpose\)/);
  assert.match(source, /getStripeCredentials\(tenantData\.id, purpose\)/);
  assert.match(source, /configurationError: stripeConfigurationError/);
  assert.match(source, /mode: stripeMode/);
});

test('form payment UI requests provider availability for the resolved payment purpose', async () => {
  const source = await readFile(
    new URL('../../client/src/components/forms/FormPaymentSubmit.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /membershipQuote\?\.matched \? 'membership' : 'forms'/);
  assert.match(source, /form-payment-providers\?purpose=\$\{encodeURIComponent\(paymentPurpose\)\}/);
  assert.match(source, /\[paymentPurpose\]/);
  assert.match(source, /json\.publishableKey/);
  assert.match(source, /stripeConfigurationError/);
});

function selectionDb(seed) {
  return {
    from(table) {
      const filters = [];
      const rows = seed[table] || [];
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        in(column, values) { filters.push([column, values.map(String)]); return query; },
        order() {
          return Promise.resolve({
            data: rows.filter(row => filters.every(([column, value]) => (
              Array.isArray(value) ? value.includes(String(row[column])) : row[column] === value
            ))),
            error: null,
          });
        },
        maybeSingle() {
          return Promise.resolve({
            data: rows.find(row => filters.every(([column, value]) => row[column] === value)) || null,
            error: null,
          });
        },
      };
      return query;
    },
  };
}

test('paid validation rejects a tenant-valid organisation from a different selected group', async () => {
  const response = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  const form = {
    id: 'paid-form',
    fields: [
      { id: 'group', type: 'organisation_group_dropdown' },
      { id: 'org', type: 'organisation_dropdown', organisation_group_parent_field_id: 'group' },
    ],
  };
  const valid = await validatePaymentRelationships(
    response,
    selectionDb({
      organization_group: [
        { id: 'group-1', tenant_id: 'tenant-1', name: 'One' },
        { id: 'group-2', tenant_id: 'tenant-1', name: 'Two' },
      ],
      organization: [
        { id: 'org-2', tenant_id: 'tenant-1', organization_group_id: 'group-2', name: 'Wrong group' },
      ],
    }),
    { id: 'tenant-1' },
    form,
    { group: 'group-1', org: 'org-2' },
  );
  assert.equal(valid, false);
  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /selected group/i);
});