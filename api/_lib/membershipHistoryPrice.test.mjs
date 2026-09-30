import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichMembershipHistoryPrices } from './membershipHistoryPrice.js';

function queryResult(data) {
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    order() { return chain; },
    limit() { return chain; },
    async maybeSingle() { return { data, error: null }; },
  };
  return chain;
}

function database(agreement, plan) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      return queryResult(table === 'membership_billing_agreements' ? agreement : plan);
    },
  };
}

const dynamicPolicy = {
  version: 1,
  end_policy: 'continue',
  pricing_policy: 'dynamic',
};

function fixture() {
  const row = {
    id: 'history',
    tenant_id: 'tenant',
    member_id: 'member',
    membership_source: 'personal',
    billing_agreement_id: 'agreement',
    payment_method: 'direct_debit',
    currency: 'GBP',
    commitment_snapshot: { collection_policy: dynamicPolicy },
  };
  const agreement = {
    id: 'agreement',
    tenant_id: 'tenant',
    member_id: 'member',
    organization_id: null,
    provider: 'gocardless',
    status: 'active',
    metadata: { dd: { collection_policy: dynamicPolicy, currency: 'GBP' } },
  };
  const plan = {
    id: 'plan',
    tenant_id: 'tenant',
    member_id: 'member',
    organization_id: null,
    billing_agreement_id: 'agreement',
    status: 'active',
  };
  return { row, agreement, plan };
}

test('accepts only fresh calculated or future provider price evidence', async () => {
  const { row, agreement, plan } = fixture();
  const db = database(agreement, plan);
  await enrichMembershipHistoryPrices([row], {
    db,
    tenantId: 'tenant',
    now: new Date('2027-01-01T12:00:00Z'),
    loadDetails: async () => ({
      pricePreview: {
        amount: 18,
        currency: 'GBP',
        dueDate: '2027-02-01',
        label: 'Current calculated price — not a confirmed charge',
      },
    }),
  });
  assert.deepEqual(row.monthly_price, {
    state: 'calculated', amount: 18, currency: 'GBP', date: '2027-02-01',
  });

  const stale = { ...fixture().row };
  await enrichMembershipHistoryPrices([stale], {
    db,
    tenantId: 'tenant',
    now: new Date('2027-01-01T12:00:00Z'),
    loadDetails: async () => ({
      pricePreview: {
        amount: 12,
        currency: 'GBP',
        dueDate: '2027-02-01',
        label: 'Reserved price — not a confirmed charge',
      },
    }),
  });
  assert.equal(stale.monthly_price.state, 'unavailable');
  assert.equal(stale.monthly_price.amount, null);

  const scheduled = { ...fixture().row };
  await enrichMembershipHistoryPrices([scheduled], {
    db,
    tenantId: 'tenant',
    now: new Date('2027-01-01T12:00:00Z'),
    loadDetails: async () => ({
      upcomingCollection: {
        amount: 13.5, currency: 'GBP', dueDate: '2027-01-10',
      },
    }),
  });
  assert.deepEqual(scheduled.monthly_price, {
    state: 'provider_scheduled', amount: 13.5, currency: 'GBP', date: '2027-01-10',
  });
});

test('fails closed when linked agreement or plan does not own the history row', async () => {
  for (const mismatch of ['agreement', 'plan']) {
    const { row, agreement, plan } = fixture();
    if (mismatch === 'agreement') agreement.member_id = 'other-member';
    else plan.member_id = 'other-member';
    let detailsRead = false;
    await enrichMembershipHistoryPrices([row], {
      db: database(agreement, plan),
      tenantId: 'tenant',
      loadDetails: async () => {
        detailsRead = true;
        return {};
      },
    });
    assert.equal(detailsRead, false);
    assert.equal(row.monthly_price.state, 'unavailable');
  }
});

test('bounds linked reads and rejects old or malformed pricing dates', async () => {
  const { agreement, plan } = fixture();
  const db = database(agreement, plan);
  const rows = Array.from({ length: 25 }, (_, index) => ({
    ...fixture().row,
    id: `history-${index}`,
  }));
  await enrichMembershipHistoryPrices(rows, {
    db,
    tenantId: 'tenant',
    now: new Date('2027-01-10T12:00:00Z'),
    loadDetails: async () => ({
      pricePreview: {
        amount: 20,
        currency: 'GBP',
        dueDate: '2027-01-09',
        label: 'Current calculated price — not a confirmed charge',
      },
    }),
  });
  assert.equal(db.calls.filter((table) => table === 'membership_billing_agreements').length, 20);
  assert.equal(db.calls.filter((table) => table === 'membership_payment_plans').length, 20);
  assert.equal(rows[0].monthly_price.state, 'unavailable');
  assert.equal(rows[20].monthly_price.state, 'unavailable');
});

test('signup price is independent of unavailable or different current price, never copied from history snapshot', async () => {
  const { row, agreement, plan } = fixture();
  agreement.metadata.dd.monthly_amount_minor = 1300;
  agreement.metadata.dd.monthly_amount = 13;
  const db = database(agreement, plan);
  await enrichMembershipHistoryPrices([row], { db, tenantId: 'tenant',
    loadDetails: async () => ({ pricePreview: { amount: 19, currency: 'GBP',
      dueDate: '2027-02-01', label: 'Current calculated price — not a confirmed charge' } }),
    now: new Date('2027-01-01') });
  assert.deepEqual(row.signup_monthly_price, { amount: 13, currency: 'GBP', variable: true });
  assert.equal(row.monthly_price.amount, 19);
  const noPlan = { ...fixture().row };
  await enrichMembershipHistoryPrices([noPlan], { db: database(agreement, null), tenantId: 'tenant' });
  assert.deepEqual(noPlan.signup_monthly_price, { amount: 13, currency: 'GBP', variable: true });
  assert.equal(noPlan.monthly_price.amount, null);
  assert.equal(noPlan.monthly_price.state, 'unavailable');
});

test('signup history price rejects missing, ambiguous, cross-owner, cross-tenant and wrong-ID evidence', async () => {
  for (const changed of [
    { metadata: { dd: { collection_policy: dynamicPolicy, currency: 'GBP' } } },
    { metadata: { dd: { collection_policy: dynamicPolicy, currency: 'GBP', monthly_amount_minor: 1300, monthly_amount: 12 } } },
    { member_id: 'other' }, { tenant_id: 'other' }, { id: 'other' }, { provider: 'stripe' },
  ]) {
    const { row, agreement } = fixture();
    row.commitment_snapshot.amounts = { monthly_amount: 99, currency: 'GBP' };
    Object.assign(agreement, changed);
    await enrichMembershipHistoryPrices([row], { db: database(agreement, null), tenantId: 'tenant' });
    assert.equal(row.signup_monthly_price, undefined, JSON.stringify(changed));
  }
});