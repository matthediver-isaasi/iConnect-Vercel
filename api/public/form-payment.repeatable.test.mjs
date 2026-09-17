import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  membershipAllowsPaymentProvider,
  validatePaymentRelationships,
  oneOffStripePaymentLifecycle,
  succeededStripeIntentMatchesSubmission,
} from './form-payment.js';

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

test('paid paths pass persisted form configuration and submitted answers to the shared row validator', async () => {
  const source = await readFile(new URL('./form-payment.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function validatePaymentRelationships');
  const end = source.indexOf('\nasync function ', start);
  const validationHelper = source.slice(start, end);
  assert.match(
    validationHelper,
    /validateRepeatableRowSubmission\(\{[\s\S]*?tenantId: tenantData\.id,[\s\S]*?form,[\s\S]*?submissionData: values/,
  );
  assert.match(validationHelper, /hiddenFieldIds/);
  assert.doesNotMatch(validationHelper, /values\.(?:fields|option_source)/);
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

test('payment idempotency race winners recheck answers before reusing the row', async () => {
  const source = await readFile(new URL('./form-payment.js', import.meta.url), 'utf8');
  const monthlyRace = source.slice(
    source.indexOf("if (error?.code === '23505' && idemKey)"),
    source.indexOf('\n  if (submission.payment_provider', source.indexOf("if (error?.code === '23505' && idemKey)")),
  );
  const ordinaryRace = source.slice(
    source.indexOf("if (insertError.code === '23505' && idemKey)"),
    source.indexOf('\n      if (!submissionRow)', source.indexOf("if (insertError.code === '23505' && idemKey)")),
  );
  assert.match(monthlyRace, /samePaymentIdempotencyAnswers\(winner\.submission_data, values\)/);
  assert.match(ordinaryRace, /samePaymentIdempotencyAnswers\(winner\.submission_data, values\)/);
});

test('lost-confirmation create retry validates a discovered succeeded intent and returns its durable lifecycle', async () => {
  const submission = {
    id: 'submission-1',
    payment_meta: { completion: { version: 1, status: 'queued' } },
  };
  const paymentIntent = {
    id: 'pi_succeeded',
    amount_received: 1250,
    currency: 'gbp',
    metadata: {
      type: 'form_payment',
      form_submission_id: submission.id,
      form_id: 'form-1',
      tenant_id: 'tenant-1',
    },
  };
  assert.equal(succeededStripeIntentMatchesSubmission({
    paymentIntent,
    submission,
    tenantId: 'tenant-1',
    formId: 'form-1',
    expectedMinor: 1250,
    currency: 'GBP',
  }), true);
  assert.equal(succeededStripeIntentMatchesSubmission({
    paymentIntent: { ...paymentIntent, metadata: { ...paymentIntent.metadata, tenant_id: 'other-tenant' } },
    submission,
    tenantId: 'tenant-1',
    formId: 'form-1',
    expectedMinor: 1250,
    currency: 'GBP',
  }), false);
  const lifecycle = oneOffStripePaymentLifecycle(submission);
  assert.equal(lifecycle.success, false);
  assert.equal(lifecycle.status, 'finalizing');
  assert.equal(lifecycle.alreadyPaid, undefined);
});

test('paid create retry returns terminal completion attention without provider recheck', async () => {
  const lifecycle = oneOffStripePaymentLifecycle({
    id: 'attention-submission',
    payment_meta: { completion: { version: 1, status: 'attention' } },
  });
  assert.deepEqual(lifecycle, {
    success: false,
    paymentSucceeded: true,
    submissionId: 'attention-submission',
    provider: 'stripe',
    status: 'attention',
    pending: false,
    retryable: false,
    requiresAttention: true,
    error: 'Your payment was recorded, but completion requires administrator review. Please do not pay again.',
  });
});

test('one-off create discovered success queues before paid CAS and never uses alreadyPaid', async () => {
  const source = await readFile(new URL('./form-payment.js', import.meta.url), 'utf8');
  const create = source.slice(source.indexOf('async function handleCreate('));
  const discovered = create.slice(create.indexOf("if (prior.kind === 'succeeded')"), create.indexOf("if (prior.kind === 'reusable')"));
  assert.ok(discovered.indexOf('succeededStripeIntentMatchesSubmission') >= 0);
  assert.ok(discovered.indexOf('queueFormPaymentCompletion') < discovered.indexOf('markFormSubmissionPaid'));
  assert.doesNotMatch(discovered, /alreadyPaid/);
  assert.doesNotMatch(create, /alreadyPaid/);
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

test('paid validation rejects a repeatable value selected in its persisted earlier source', async () => {
  const response = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  const form = {
    id: 'paid-form',
    fields: [
      { id: 'primary', type: 'select', options: ['A', 'B'] },
      {
        id: 'rows',
        type: 'repeatable_rows',
        children: [{
          id: 'additional',
          type: 'select',
          options: ['A', 'B'],
          exclude_values_from: { scope: 'form', source_field_id: 'primary' },
        }],
      },
    ],
  };
  const valid = await validatePaymentRelationships(
    response,
    { from() { throw new Error('excluded static choice must fail before database work'); } },
    { id: 'tenant-1' },
    form,
    { primary: 'A', rows: [{ additional: 'A' }] },
  );
  assert.equal(valid, false);
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.code, 'excluded_repeatable_value');
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

test('paid validation rejects invalid future-only answers before any database lookup', async () => {
  let queries = 0;
  const response = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  const form = {
    id: 'paid-form',
    fields: [{
      id: 'start_date',
      type: 'date',
      future_only: true,
    }],
  };
  const valid = await validatePaymentRelationships(
    response,
    { from() { queries += 1; throw new Error('future date must fail before database work'); } },
    { id: 'tenant-1' },
    form,
    { start_date: '2020-01-01' },
  );
  assert.equal(valid, false);
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.code, 'FUTURE_DATE_INVALID');
  assert.equal(response.payload.details[0].field_id, 'start_date');
  assert.equal(queries, 0);
});

test('paid validation skips hidden future-only repeatable dates while validating active rows', async () => {
  const response = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  const form = {
    id: 'paid-form',
    fields: [
      {
        id: 'rows',
        type: 'repeatable_rows',
        starts_hidden: true,
        child_fields: [{
          id: 'start_date',
          type: 'date',
          future_only: true,
        }],
      },
    ],
  };
  const valid = await validatePaymentRelationships(
    response,
    { from() { throw new Error('hidden repeatable date must not query'); } },
    { id: 'tenant-1' },
    form,
    { rows: [{ start_date: '2020-01-01' }] },
  );
  assert.equal(valid, true);
  assert.equal(response.statusCode, null);
});

test('payment submission validation accepts every repeatable date precision and restriction', async () => {
  const cases = [
    [{ date_precision: 'day', date_restriction: 'any' }, '2024-02-29'],
    [{ date_precision: 'month', date_restriction: 'any' }, '2024-02'],
    [{ date_precision: 'year', date_restriction: 'any' }, '2024'],
    [{ date_precision: 'day', date_restriction: 'future' }, '2099-02-01'],
    [{ date_precision: 'month', date_restriction: 'future' }, '2099-02'],
    [{ date_precision: 'year', date_restriction: 'future' }, '2099'],
    [{ date_precision: 'day', date_restriction: 'past' }, '2001-02-01'],
    [{ date_precision: 'month', date_restriction: 'past' }, '2001-02'],
    [{ date_precision: 'year', date_restriction: 'past' }, '2001'],
  ];
  for (const [settings, answer] of cases) {
    const response = {
      statusCode: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };
    const valid = await validatePaymentRelationships(
      response,
      selectionDb({}),
      { id: 'tenant-1' },
      {
        id: 'paid-form',
        fields: [{
          id: 'dates',
          type: 'repeatable_rows',
          children: [{ id: 'answer', type: 'date', ...settings }],
        }],
      },
      { dates: [{ _row_id: 'row-1', answer }] },
    );
    assert.equal(valid, true, `${settings.date_precision}/${settings.date_restriction}`);
    assert.equal(response.statusCode, null);
  }
});

test('payment validation rejects malformed repeatable partial dates before provider work', async () => {
  for (const [settings, answer] of [
    [{ date_precision: 'day', date_restriction: 'any' }, '2024-02'],
    [{ date_precision: 'month', date_restriction: 'any' }, '2024-02-29'],
    [{ date_precision: 'year', date_restriction: 'any' }, '2024-01'],
    [{ date_precision: 'month', date_restriction: 'any' }, '2024-13'],
  ]) {
    const response = {
      statusCode: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };
    const valid = await validatePaymentRelationships(
      response,
      { from() { throw new Error('malformed date must fail before provider/database work'); } },
      { id: 'tenant-1' },
      {
        id: 'paid-form',
        fields: [{
          id: 'dates',
          type: 'repeatable_rows',
          children: [{ id: 'answer', type: 'date', ...settings }],
        }],
      },
      { dates: [{ _row_id: 'row-1', answer }] },
    );
    assert.equal(valid, false);
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.code, 'FUTURE_DATE_INVALID');
    assert.equal(response.payload.details[0].child_id, 'answer');
  }
});

test('payment confirmation retry skips date revalidation for an already accepted submission', async () => {
  const response = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  const valid = await validatePaymentRelationships(
    response,
    selectionDb({}),
    { id: 'tenant-1' },
    {
      id: 'paid-form',
      fields: [{
        id: 'dates',
        type: 'repeatable_rows',
        children: [{
          id: 'answer',
          type: 'date',
          date_precision: 'month',
          date_restriction: 'future',
        }],
      }],
    },
    { dates: [{ _row_id: 'row-1', answer: '2001-01' }] },
    {},
    { skipFutureDateValidation: true },
  );
  assert.equal(valid, true);
  assert.equal(response.statusCode, null);
});

test('payment confirm callback does not re-run form answer validation after provider confirmation', async () => {
  const source = await readFile(new URL('./form-payment.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function handleConfirm');
  const end = source.indexOf('\nasync function ', start + 1);
  const confirmSection = source.slice(start, end < 0 ? source.length : end);
  assert.doesNotMatch(confirmSection, /validatePaymentRelationships\(/);
  assert.match(source, /skipFutureDateValidation: !!existingIdempotentPayment/);
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
  assert.match(source, /queryKey: \['form-payment-providers', paymentPurpose\]/);
  assert.match(source, /json\.publishableKey/);
  assert.match(source, /stripeConfigurationError/);
});

test('membership schedules authoritatively gate GoCardless without changing generic or card payments', () => {
  const disabledMembership = { quote: { direct_debit_allowed: false } };
  const enabledMembership = { quote: { direct_debit_allowed: true } };
  assert.equal(membershipAllowsPaymentProvider('gocardless', disabledMembership), false);
  assert.equal(membershipAllowsPaymentProvider('gocardless', enabledMembership), true);
  assert.equal(membershipAllowsPaymentProvider('gocardless', null), true);
  assert.equal(membershipAllowsPaymentProvider('stripe', disabledMembership), true);
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