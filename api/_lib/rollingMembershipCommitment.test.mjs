import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildRollingCommitment, commitmentFromAgreement, recoverRollingCommitment, persistRollingCommitment,
} from './rollingMembershipCommitment.js';

const config = { id: 'cfg', start_mode: 'immediate', billing_period: 'annual', currency: 'GBP', dd_monthly_amount: 20 };
const amounts = { annual_cost: 240, final_cost: 240, vat_amount: 0, total_with_vat: 240, currency: 'GBP', monthly_amount: 20, instalment_count: 12 };
const make = (paymentMethod = 'direct_debit') => buildRollingCommitment({
  config, startDate: '2026-09-15', paymentMethod, paymentFrequency: paymentMethod === 'stripe' ? 'upfront' : 'monthly', amounts,
});
const history = { id: 'history', tenant_id: 'tenant', member_id: 'member', config_id: 'cfg', billing_agreement_id: 'agreement', ...amounts };

test('all payment rails share an annual term, and caller mutations cannot reprice snapshots', () => {
  for (const rail of ['stripe', 'card_monthly', 'direct_debit']) {
    const term = make(rail);
    assert.equal(term.membership_renewal_date, '2027-09-15');
    assert.equal(term.term_end_date, '2027-09-14');
    assert.equal(term.commitment_snapshot.payment_method, rail);
  }
  const term = make();
  config.dd_monthly_amount = 25;
  amounts.monthly_amount = 25;
  assert.equal(term.commitment_snapshot.config.dd_monthly_amount, 20);
  assert.equal(term.commitment_snapshot.amounts.monthly_amount, 20);
  config.dd_monthly_amount = amounts.monthly_amount = 20;
});

test('agreement snapshots resolve from canonical columns or either provider metadata', () => {
  const commitment = make();
  for (const agreement of [commitment, { metadata: { commitment } }, { metadata: { card: { commitment } } }, { metadata: { dd: { commitment } } }]) {
    assert.deepEqual(commitmentFromAgreement(agreement), commitment);
  }
  assert.equal(commitmentFromAgreement({ metadata: { card: { membership_year: '2026/2027' } } }), null);
});

test('legacy recovery accepts immutable consent config, exact financials and dated commencement, not current config/year/payment dates', () => {
  const agreement = {
    id: 'agreement', tenant_id: 'tenant', member_id: 'member', provider: 'gocardless',
    metadata: { dd: { config_id: 'cfg', config_snapshot: config, membership_year_start: '2026-09-15', ...amounts } },
  };
  const recovered = recoverRollingCommitment({ history, agreement });
  assert.equal(recovered.status, 'recoverable');
  assert.equal(recovered.patch.membership_renewal_date, '2027-09-15');
  assert.equal(recovered.agreement_patch.id, agreement.id);
  assert.equal(recoverRollingCommitment({ history, agreement: { ...agreement, tenant_id: 'foreign' } }).status, 'review');
  assert.equal(recoverRollingCommitment({ history: { ...history, final_cost: 250 }, agreement }).status, 'review');
  assert.equal(recoverRollingCommitment({ history, agreement: { ...agreement, metadata: { dd: { ...agreement.metadata.dd, config_snapshot: null } } } }).status, 'review');
  assert.equal(recoverRollingCommitment({ history: { ...history, created_at: '2026-09-15', paid_at: '2026-09-15', membership_year: '2026/2027' } }).status, 'review');
});

test('recovery rejects contradictory dates rather than moving the anniversary', () => {
  const commitment = make();
  const agreement = { id: 'agreement', tenant_id: 'tenant', member_id: 'member', ...commitment };
  assert.equal(recoverRollingCommitment({ history: { ...history, term_start_date: '2026-09-16' }, agreement }).status, 'review');
  assert.equal(recoverRollingCommitment({ history: { ...history, ...commitment }, agreement }).status, 'already_recorded');
});

test('legacy upfront payment quote recovery requires exact tenant and owner evidence', () => {
  const quote = {
    tenant_id: history.tenant_id, member_id: history.member_id, config_id: config.id,
    config_snapshot: config, membership_start_date: '2026-09-15',
    payment_method: 'stripe', payment_frequency: 'upfront', ...amounts,
  };
  const recovered = recoverRollingCommitment({ history, quote });
  assert.equal(recovered.status, 'recoverable');
  assert.equal(recovered.patch.membership_renewal_date, '2027-09-15');
  assert.equal(recoverRollingCommitment({ history, quote: { ...quote, member_id: 'other' } }).status, 'review');
  assert.equal(recoverRollingCommitment({ history, quote: { ...quote, membership_year_start: '2026-09-16' } }).status, 'review');
});

test('recovery CLI defaults to a read-only review report and rejects apply without explicit tenant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rolling-recovery-fixture-'));
  try {
    const file = join(dir, 'evidence.json');
    const input = JSON.stringify([{ history: { ...history, created_at: '2026-09-15' } }]);
    await writeFile(file, input);
    const script = new URL('../../scripts/recover-rolling-membership-commitments.mjs', import.meta.url);
    const output = JSON.parse(execFileSync(process.execPath, [script.pathname, file], { encoding: 'utf8' }));
    assert.equal(output.dry_run, true);
    assert.equal(output.results[0].status, 'review');
    assert.deepEqual(await readdir(dir), ['evidence.json']);
    assert.throws(() => execFileSync(process.execPath, [script.pathname, '--apply', file], { stdio: 'pipe' }), /Command failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persistence requires explicit tenant/owner and propagates DB errors', async () => {
  await assert.rejects(() => persistRollingCommitment({}, { record: make() }), /tenant/);
  await assert.rejects(() => persistRollingCommitment({ rpc: async () => ({ error: { message: 'overlap' } }) }, {
    tenantId: 'tenant', memberId: 'member', record: make(),
  }), /overlap/);
  assert.deepEqual(buildRollingCommitment({ config: { start_mode: 'fixed_date' } }), {});
  assert.throws(() => buildRollingCommitment({ config, startDate: '2026-09-15', paymentMethod: 'card', paymentFrequency: 'upfront', amounts: { ...amounts, final_cost: null } }), /agreed final_cost/);
});