import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  claimFormMonthlyCardMembership,
  findExistingFormApplicantMember,
  findFormMonthlyCardAgreement,
  formMonthlyCardAgreementKey,
  formMonthlyCardApplicantAgreementKey,
  normalizeFormMonthlyCardEmail,
  persistMonthlyCheckoutLink,
  releaseExpiredFormMonthlyCardCheckout,
} from './formMonthlyCardCheckout.js';

function updateDb(result) {
  const writes = [];
  return {
    writes,
    from(table) {
      const chain = {
        update(payload) { writes.push({ table, payload }); return chain; },
        eq() { return chain; },
        select() { return chain; },
        maybeSingle: async () => result,
      };
      return chain;
    },
  };
}

test('agreement key is stable per form submission', () => {
  assert.equal(formMonthlyCardAgreementKey('sub-1'), 'form-card:sub-1');
});

test('normalizeFormMonthlyCardEmail lowercases, trims, and tolerates non-strings', () => {
  assert.equal(normalizeFormMonthlyCardEmail('  Person@Example.COM '), 'person@example.com');
  assert.equal(normalizeFormMonthlyCardEmail(''), '');
  assert.equal(normalizeFormMonthlyCardEmail(null), '');
  assert.equal(normalizeFormMonthlyCardEmail(undefined), '');
  assert.equal(normalizeFormMonthlyCardEmail(42), '');
});

test('applicant agreement key is case-insensitive and stable across email formatting', () => {
  const base = formMonthlyCardApplicantAgreementKey({
    tenantId: 'tenant-1',
    email: 'person@example.com',
    membershipYear: 2025,
  });
  const reformatted = formMonthlyCardApplicantAgreementKey({
    tenantId: 'tenant-1',
    email: '  Person@Example.COM ',
    membershipYear: 2025,
  });
  assert.equal(base, reformatted);
  assert.match(base, /^form-card-applicant:[0-9a-f]{64}$/);
  // Stable across repeated calls with identical inputs.
  assert.equal(base, formMonthlyCardApplicantAgreementKey({
    tenantId: 'tenant-1',
    email: 'person@example.com',
    membershipYear: 2025,
  }));
});

test('applicant agreement key differs by membership year, tenant, and email', () => {
  const y2025 = formMonthlyCardApplicantAgreementKey({
    tenantId: 'tenant-1',
    email: 'person@example.com',
    membershipYear: 2025,
  });
  const y2026 = formMonthlyCardApplicantAgreementKey({
    tenantId: 'tenant-1',
    email: 'person@example.com',
    membershipYear: 2026,
  });
  const otherTenant = formMonthlyCardApplicantAgreementKey({
    tenantId: 'tenant-2',
    email: 'person@example.com',
    membershipYear: 2025,
  });
  const otherEmail = formMonthlyCardApplicantAgreementKey({
    tenantId: 'tenant-1',
    email: 'other@example.com',
    membershipYear: 2025,
  });
  assert.notEqual(y2025, y2026);
  assert.notEqual(y2025, otherTenant);
  assert.notEqual(y2025, otherEmail);
});

test('applicant agreement key requires tenant, applicant email, and membership year', () => {
  assert.throws(() => formMonthlyCardApplicantAgreementKey({
    email: 'person@example.com',
    membershipYear: 2025,
  }), /required/);
  assert.throws(() => formMonthlyCardApplicantAgreementKey({
    tenantId: 'tenant-1',
    email: '   ',
    membershipYear: 2025,
  }), /required/);
  assert.throws(() => formMonthlyCardApplicantAgreementKey({
    tenantId: 'tenant-1',
    email: 'person@example.com',
  }), /required/);
});

function selectDb(result, calls) {
  return {
    from(table) {
      const record = { table, filters: [], limit: null };
      calls.push(record);
      const chain = {
        select() { return chain; },
        eq(column, value) { record.filters.push([column, value]); return chain; },
        ilike(column, value) { record.filters.push(['ilike:' + column, value]); return chain; },
        limit(n) { record.limit = n; return Promise.resolve(result); },
      };
      return chain;
    },
  };
}

test('findExistingFormApplicantMember does an exact, tenant-scoped, case-insensitive lookup', async () => {
  const calls = [];
  const db = selectDb({ data: [{ id: 'member-1', email: 'Person@Example.com' }], error: null }, calls);
  const result = await findExistingFormApplicantMember(db, {
    tenantId: 'tenant-1',
    email: '  Person@Example.COM ',
  });
  assert.deepEqual(result, { data: { id: 'member-1', email: 'Person@Example.com' }, error: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, 'member');
  assert.equal(calls[0].limit, 2);
  assert.deepEqual(calls[0].filters, [
    ['tenant_id', 'tenant-1'],
    ['ilike:email', 'person@example.com'],
  ]);
});

test('findExistingFormApplicantMember escapes ILIKE wildcards so email stays an exact identity', async () => {
  const calls = [];
  const db = selectDb({ data: [], error: null }, calls);
  await findExistingFormApplicantMember(db, {
    tenantId: 'tenant-1',
    email: 'a_b%c\\d@example.com',
  });
  assert.deepEqual(calls[0].filters[1], ['ilike:email', 'a\\_b\\%c\\\\d@example.com']);
});

test('findExistingFormApplicantMember short-circuits when tenant or email is missing', async () => {
  const calls = [];
  const db = selectDb({ data: [{ id: 'never' }], error: null }, calls);
  assert.deepEqual(await findExistingFormApplicantMember(db, { tenantId: '', email: 'a@b.com' }), { data: null, error: null });
  assert.deepEqual(await findExistingFormApplicantMember(db, { tenantId: 'tenant-1', email: '' }), { data: null, error: null });
  assert.equal(calls.length, 0);
});

test('findExistingFormApplicantMember rejects ambiguous multi-member matches', async () => {
  const calls = [];
  const db = selectDb({ data: [{ id: 'member-1' }, { id: 'member-2' }], error: null }, calls);
  const result = await findExistingFormApplicantMember(db, { tenantId: 'tenant-1', email: 'a@b.com' });
  assert.equal(result.data, null);
  assert.match(result.error.message, /more than one member/);
});

test('findExistingFormApplicantMember surfaces database errors', async () => {
  const calls = [];
  const dbError = { message: 'db down' };
  const db = selectDb({ data: null, error: dbError }, calls);
  const result = await findExistingFormApplicantMember(db, { tenantId: 'tenant-1', email: 'a@b.com' });
  assert.equal(result.data, null);
  assert.equal(result.error, dbError);
});

function rpcDb(result) {
  const calls = [];
  return {
    calls,
    rpc(name, params) {
      calls.push({ name, params });
      return Promise.resolve(result);
    },
  };
}

test('releaseExpiredFormMonthlyCardCheckout calls the transactional server-only RPC', async () => {
  const db = rpcDb({
    data: { ok: true, released: true, idempotent: false },
    error: null,
  });
  const result = await releaseExpiredFormMonthlyCardCheckout(db, {
    agreementId: 'agreement-1',
    checkoutSessionId: 'cs_expired',
  });
  assert.deepEqual(db.calls, [{
    name: 'release_expired_form_monthly_card_checkout',
    params: {
      p_agreement_id: 'agreement-1',
      p_checkout_session_id: 'cs_expired',
    },
  }]);
  assert.deepEqual(result, {
    ok: true,
    released: true,
    idempotent: false,
    retryable: false,
    code: null,
    detail: null,
  });
});

test('releaseExpiredFormMonthlyCardCheckout fails closed on RPC and validation errors', async () => {
  assert.deepEqual(
    await releaseExpiredFormMonthlyCardCheckout(rpcDb({ data: null, error: null }), {
      agreementId: null,
      checkoutSessionId: 'cs_expired',
    }),
    {
      ok: false,
      retryable: false,
      detail: 'agreement and Checkout session are required',
    },
  );
  const rpcFailure = await releaseExpiredFormMonthlyCardCheckout(
    rpcDb({ data: null, error: { message: 'database unavailable' } }),
    { agreementId: 'agreement-1', checkoutSessionId: 'cs_expired' },
  );
  assert.equal(rpcFailure.ok, false);
  assert.equal(rpcFailure.retryable, true);
  assert.match(rpcFailure.detail, /database unavailable/);

  const guarded = await releaseExpiredFormMonthlyCardCheckout(
    rpcDb({
      data: { ok: false, code: 'PAYMENT_PLAN_EXISTS', detail: 'plan exists' },
      error: null,
    }),
    { agreementId: 'agreement-1', checkoutSessionId: 'cs_expired' },
  );
  assert.equal(guarded.ok, false);
  assert.equal(guarded.retryable, true);
  assert.equal(guarded.code, 'PAYMENT_PLAN_EXISTS');
});

test('claimFormMonthlyCardMembership reports success from the atomic RPC', async () => {
  const db = rpcDb({ data: { ok: true, history_id: 'hist-1', idempotent: true }, error: null });
  const result = await claimFormMonthlyCardMembership(db, {
    agreementId: 'agreement-1',
    submissionId: 'sub-1',
    memberId: 'member-1',
    history: { note: 'x' },
  });
  assert.deepEqual(result, { ok: true, historyId: 'hist-1', idempotent: true, reserved: false });
  assert.deepEqual(db.calls[0], {
    name: 'claim_form_monthly_card_membership',
    params: {
      p_agreement_id: 'agreement-1',
      p_submission_id: 'sub-1',
      p_member_id: 'member-1',
      p_history: { note: 'x' },
      p_reserve_only: false,
    },
  });
});

test('claimFormMonthlyCardMembership forwards reserveOnly and supports a pre-charge reservation', async () => {
  const db = rpcDb({ data: { ok: true, reserved: true }, error: null });
  const result = await claimFormMonthlyCardMembership(db, {
    agreementId: 'agreement-1',
    submissionId: 'sub-1',
    memberId: 'member-1',
    reserveOnly: true,
  });
  assert.equal(db.calls[0].params.p_reserve_only, true);
  // A reservation succeeds before charging without inserting the history row.
  assert.deepEqual(result, { ok: true, historyId: null, idempotent: false, reserved: true });
});

test('claimFormMonthlyCardMembership defaults history to an empty object', async () => {
  const db = rpcDb({ data: { ok: true }, error: null });
  await claimFormMonthlyCardMembership(db, {
    agreementId: 'agreement-1',
    submissionId: 'sub-1',
    memberId: 'member-1',
  });
  assert.deepEqual(db.calls[0].params.p_history, {});
});

test('claimFormMonthlyCardMembership treats an RPC transport error as retryable', async () => {
  const db = rpcDb({ data: null, error: { message: 'deadlock detected' } });
  const result = await claimFormMonthlyCardMembership(db, {
    agreementId: 'agreement-1',
    submissionId: 'sub-1',
    memberId: 'member-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.detail, /membership-year claim failed: deadlock detected/);
});

test('claimFormMonthlyCardMembership maps a conflict result to a non-retryable conflict', async () => {
  const db = rpcDb({
    data: {
      ok: false,
      conflict: true,
      code: 'YEAR_TAKEN',
      detail: 'membership year already reserved',
      history_id: 'hist-9',
      agreement_id: 'agreement-9',
    },
    error: null,
  });
  const result = await claimFormMonthlyCardMembership(db, {
    agreementId: 'agreement-1',
    submissionId: 'sub-1',
    memberId: 'member-1',
  });
  assert.deepEqual(result, {
    ok: false,
    conflict: true,
    retryable: false,
    code: 'YEAR_TAKEN',
    detail: 'membership year already reserved',
    historyId: 'hist-9',
    conflictingAgreementId: 'agreement-9',
  });
});

test('claimFormMonthlyCardMembership keeps a non-conflict failure retryable', async () => {
  const db = rpcDb({ data: { ok: false }, error: null });
  const result = await claimFormMonthlyCardMembership(db, {
    agreementId: 'agreement-1',
    submissionId: 'sub-1',
    memberId: 'member-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.conflict, false);
  assert.equal(result.retryable, true);
  assert.equal(result.detail, 'membership-year claim did not complete');
});

test('persistMonthlyCheckoutLink publishes the durable agreement/session binding', async () => {
  const linked = {
    id: 'sub-1',
    payment_status: 'pending',
    payment_meta: {
      membership: { quote: { config_id: 'cfg-1' } },
      monthly_card: {
        offer: { monthlyAmountMinor: 2500 },
        agreement_id: 'agreement-1',
        checkout_url: 'https://checkout.stripe.test/session',
        checkout_session_id: 'cs_1',
      },
    },
  };
  const db = updateDb({ data: linked, error: null });
  const result = await persistMonthlyCheckoutLink(
    db,
    { id: 'sub-1', payment_status: 'pending', payment_meta: { membership: { quote: { config_id: 'cfg-1' } } } },
    { monthlyAmountMinor: 2500 },
    {
      id: 'agreement-1',
      redirect_url: 'https://checkout.stripe.test/session',
      stripe_checkout_session_id: 'cs_1',
    },
  );
  assert.equal(result.payment_meta.monthly_card.agreement_id, 'agreement-1');
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].payload.payment_meta.membership.quote.config_id, 'cfg-1');
});

test('persistMonthlyCheckoutLink is a no-op when a retry is already linked', async () => {
  const submission = {
    id: 'sub-1',
    payment_status: 'pending',
    payment_meta: {
      monthly_card: {
        offer: { monthlyAmountMinor: 2500 },
        agreement_id: 'agreement-1',
        checkout_url: 'https://checkout.stripe.test/session',
        checkout_session_id: 'cs_1',
      },
    },
  };
  const db = updateDb({ data: null, error: new Error('must not write') });
  const result = await persistMonthlyCheckoutLink(db, submission, submission.payment_meta.monthly_card.offer, {
    id: 'agreement-1',
    redirect_url: 'https://checkout.stripe.test/session',
    stripe_checkout_session_id: 'cs_1',
  });
  assert.equal(result, submission);
  assert.equal(db.writes.length, 0);
});

test('failed linkage write remains retryable instead of exposing an untracked checkout', async () => {
  const db = updateDb({ data: null, error: { message: 'network failure' } });
  await assert.rejects(
    persistMonthlyCheckoutLink(db, { id: 'sub-1', payment_meta: {} }, {}, {
      id: 'agreement-1',
      redirect_url: 'https://checkout.stripe.test/session',
      stripe_checkout_session_id: 'cs_1',
    }),
    /network failure/,
  );
});

// Returns a db whose maybeSingle results are drained in order, one per query.
function agreementLookupDb(results) {
  const queries = [];
  const remaining = [...results];
  return {
    queries,
    from(table) {
      const record = { table, filters: [] };
      queries.push(record);
      const chain = {
        select() { return chain; },
        eq(column, value) { record.filters.push([column, value]); return chain; },
        filter(column, op, value) { record.filters.push([column, op, value]); return chain; },
        maybeSingle: async () => remaining.shift() ?? { data: null, error: null },
      };
      return chain;
    },
  };
}

test('agreement lookup uses a direct id lookup when an agreementId is supplied', async () => {
  const db = agreementLookupDb([{ data: { id: 'agreement-1' }, error: null }]);
  const result = await findFormMonthlyCardAgreement(db, {
    tenantId: 'tenant-1',
    submissionId: 'sub-1',
    agreementId: 'agreement-1',
  });
  assert.equal(result.data.id, 'agreement-1');
  assert.equal(db.queries.length, 1);
  assert.deepEqual(db.queries[0].filters, [
    ['tenant_id', 'tenant-1'],
    ['id', 'agreement-1'],
  ]);
});

test('agreement lookup returns null without a tenant or submission id', async () => {
  const db = agreementLookupDb([]);
  assert.deepEqual(await findFormMonthlyCardAgreement(db, { tenantId: '', submissionId: 'sub-1' }), { data: null, error: null });
  assert.deepEqual(await findFormMonthlyCardAgreement(db, { tenantId: 'tenant-1', submissionId: '' }), { data: null, error: null });
  assert.equal(db.queries.length, 0);
});

test('agreement lookup falls back to the submission-derived idempotency key', async () => {
  const db = agreementLookupDb([{ data: { id: 'agreement-1' }, error: null }]);
  const result = await findFormMonthlyCardAgreement(db, {
    tenantId: 'tenant-1',
    submissionId: 'sub-1',
  });
  assert.equal(result.data.id, 'agreement-1');
  assert.equal(db.queries.length, 1);
  assert.deepEqual(db.queries[0].filters, [
    ['tenant_id', 'tenant-1'],
    ['idempotency_key', 'form-card:sub-1'],
  ]);
});

test('agreement lookup falls back to the submission-id metadata filter when the legacy key misses', async () => {
  const db = agreementLookupDb([
    { data: null, error: null },
    { data: { id: 'agreement-meta' }, error: null },
  ]);
  const result = await findFormMonthlyCardAgreement(db, {
    tenantId: 'tenant-1',
    submissionId: 'sub-1',
  });
  assert.equal(result.data.id, 'agreement-meta');
  assert.equal(db.queries.length, 2);
  assert.deepEqual(db.queries[1].filters, [
    ['tenant_id', 'tenant-1'],
    ['metadata->>form_submission_id', 'eq', 'sub-1'],
  ]);
});

test('agreement lookup does not fall back to metadata when the legacy key query errors', async () => {
  const db = agreementLookupDb([
    { data: null, error: { message: 'legacy key query failed' } },
    { data: { id: 'never' }, error: null },
  ]);
  const result = await findFormMonthlyCardAgreement(db, {
    tenantId: 'tenant-1',
    submissionId: 'sub-1',
  });
  assert.equal(result.data, null);
  assert.equal(result.error.message, 'legacy key query failed');
  assert.equal(db.queries.length, 1);
});

test('create retry repairs submission linkage before returning a prior Checkout URL', () => {
  const source = readFileSync(new URL('../public/form-payment.js', import.meta.url), 'utf8');
  const create = source.slice(
    source.indexOf('async function handleCreateMonthlyCard'),
    source.indexOf('async function handleCreate('),
  );
  const priorReturn = create.indexOf('checkoutUrl: prior.redirect_url');
  const repair = create.lastIndexOf('persistMonthlyCheckoutLink', priorReturn);
  assert.ok(repair > -1 && repair < priorReturn);
});

test('browser confirm and reconciliation can find an agreement when submission linkage was interrupted', () => {
  const endpoint = readFileSync(new URL('../public/form-payment.js', import.meta.url), 'utf8');
  const reconciliation = readFileSync(new URL('./formPaymentReconciliation.js', import.meta.url), 'utf8');
  assert.match(endpoint, /findFormMonthlyCardAgreement/);
  assert.match(reconciliation, /findFormMonthlyCardAgreement/);
});