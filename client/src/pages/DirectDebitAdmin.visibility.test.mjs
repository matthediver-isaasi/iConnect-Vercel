import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./DirectDebitAdmin.jsx', import.meta.url), 'utf8');

test('Direct Debit plans use the paginated API contract and reset pagination for filters', () => {
  assert.match(source, /page: String\(page\), pageSize: String\(PLAN_PAGE_SIZE\)/);
  assert.match(source, /plansData\?\.total/);
  assert.match(source, /plansData\?\.hasMore/);
  assert.match(source, /data-testid="text-plan-count"/);
  assert.match(source, /data-testid="button-plans-previous"/);
  assert.match(source, /data-testid="button-plans-next"/);
  assert.match(source, /setSearch\(e\.target\.value\); setPage\(1\)/);
  assert.match(source, /setStatusFilter\(value\); setPage\(1\)/);
});

test('Direct Debit plan UI includes first-payment plans and preserves held mandate context', () => {
  assert.match(source, /"first_payment_pending"/);
  assert.match(source, /mandatePresentation\?\.awaitingFirstPayment \? "first_payment_pending"/);
  assert.match(source, /Existing mandate active/);
  assert.match(source, /collections held/);
  assert.match(source, /contains adopted Direct Debit plans linked to membership billing/);
  assert.match(source, /Mandates found by discovery alone/);
});

test('Direct Debit views render errors instead of false empty states or zero counts', () => {
  for (const message of [
    'Plan details could not be loaded.',
    'Cancellation requests could not be loaded.',
    'Payments and payouts could not be loaded.',
    'Migration activity could not be loaded.',
    'Plan renewals could not be loaded.',
    'Direct Debit totals could not be loaded.',
    'Direct Debit plans could not be loaded.',
  ]) {
    assert.ok(source.includes(message), `missing explicit error state: ${message}`);
  }
  assert.match(source, /summaryLoading[\s\S]*summaryError[\s\S]*stat-active/);
  assert.match(source, /isLoading[\s\S]*isError[\s\S]*text-no-renewals/);
  assert.match(source, /plansLoading[\s\S]*plansError[\s\S]*text-no-plans/);
});