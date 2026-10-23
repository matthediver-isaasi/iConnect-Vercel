import test from 'node:test';
import assert from 'node:assert/strict';
import { accountingProgressSummary, attachMembershipAccountingProgress } from './membershipAccountingProgress.js';

const now = Date.parse('2026-10-23T12:00:00Z');
test('retry summaries honor explicit cooldowns and processing claim expiry', () => {
  for (const progress of [
    { invoice_state: 'retry', accounting_retry_after: '2026-10-23T12:15:00Z' },
    { invoice_state: 'processing', invoice_claimed_at: '2026-10-23T12:00:00Z' },
    { invoice_state: 'done', settlement_state: 'processing', settlement_claimed_at: '2026-10-23T12:00:00Z' },
  ]) {
    assert.deepEqual(accountingProgressSummary(progress, now), {
      state: 'waiting', retryAt: '2026-10-23T12:15:00.000Z',
    });
    assert.equal(accountingProgressSummary(progress, now + 3600000).state, 'pending');
  }
});
test('blocked and failed progress outrank retry dates; unknown is not success', () => {
  for (const field of ['status', 'integrity_state', 'invoice_state', 'settlement_state']) {
    assert.deepEqual(accountingProgressSummary({
      [field]: 'blocked', accounting_retry_after: '2026-10-24T12:00:00Z',
    }, now), { state: 'attention', retryAt: null });
  }
  assert.equal(accountingProgressSummary({ invoice_state: 'failed' }, now).state, 'attention');
  assert.equal(accountingProgressSummary({}, now).state, 'unavailable');
  assert.equal(accountingProgressSummary({ invoice_state: 'retry', accounting_retry_after: 'bad' }, now).state, 'pending');
  assert.equal(accountingProgressSummary({ invoice_state: 'done', settlement_state: 'done' }, now).state, 'complete');
});

test('read-only enrichment scopes paid source evidence and fails closed', async () => {
  for (const scenario of ['valid', 'no-diagnostic', 'wrong-table', 'wrong-entity', 'missing', 'error']) {
    const calls = [];
    const row = { id: 'history', member_id: 'member', payment_status: 'paid',
      stripe_payment_intent_id: 'pi_original', accounting_sync_status: 'failed' };
    if (scenario === 'no-diagnostic') delete row.accounting_sync_status;
    const db = { from(table) {
      calls.push(['from', table]);
      const query = {
        select(...args) { calls.push(['select', ...args]); return query; },
        eq(...args) { calls.push(['eq', ...args]); return query; },
        filter(...args) { calls.push(['filter', ...args]); return query; },
        async maybeSingle() { return {
          error: scenario === 'error' ? new Error('unavailable') : null,
          data: scenario === 'missing' ? null : { payment_meta: {
            membership: { quote: { target: 'member' } },
            membership_result: { history_id: 'history',
              table: scenario === 'wrong-table' ? 'organisation_membership_history' : 'member_membership_history',
              entity_id: scenario === 'wrong-entity' ? 'other' : 'member', invoice_state: 'retry',
              accounting_retry_after: '2026-10-23T12:15:00Z' },
          } },
        }; },
      };
      return query;
    } };
    await attachMembershipAccountingProgress(db, { tenantId: 'tenant', history: [row], now });
    assert.equal(row.payment_status, 'paid');
    assert.ok(calls.some(c => c[1] === 'tenant_id' && c[2] === 'tenant'));
    assert.ok(calls.some(c => c[1] === 'payment_reference' && c[2] === 'pi_original'));
    assert.equal(row.accounting_progress?.state,
      { valid: 'waiting', 'no-diagnostic': 'waiting', 'wrong-table': 'attention', 'wrong-entity': 'attention', missing: undefined, error: 'unavailable' }[scenario]);
    assert.equal(JSON.stringify(row).includes('payment_meta'), false);
  }
});
