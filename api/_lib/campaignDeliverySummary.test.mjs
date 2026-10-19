import test from 'node:test';
import assert from 'node:assert/strict';
import { readCampaignDeliverySummary } from './campaignDeliverySummary.js';
import { campaignRecipientLabel, campaignReconciliationAlert } from '../../shared/campaignDeliverySummary.js';
import { getCampaignSendFeedback } from '../../shared/campaignSendFeedback.js';
import { finishPreparedCampaignBatch } from './campaignBulkDrain.js';

process.env.SUPABASE_URL = 'https://campaign-outcomes.invalid';
process.env.SUPABASE_SERVICE_KEY = 'isolated-test-key';
const { supabase } = await import('./database.js');
const { getCampaignSendOutcome } = await import('./campaignService.js');

function database(rows, fail = false) {
  const reads = [];
  return { reads, from(table) {
    assert.equal(table, 'email_campaign_recipient');
    const filters = [];
    const q = {
      select(columns, options) { reads.push({ columns, options }); return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      in(k, v) { filters.push(r => v.includes(r[k])); return q; },
      is(k, v) { filters.push(r => (r[k] ?? null) === v); return q; },
      not(k, op, v) { filters.push(r => (r[k] ?? null) !== v); return q; },
      or(expression) {
        assert.equal(expression, 'sent_at.not.is.null,mailgun_message_id.not.is.null');
        filters.push(r => r.sent_at != null || r.mailgun_message_id != null); return q;
      },
      limit() { return q; },
      then(resolve, reject) {
        const data = rows.filter(r => filters.every(f => f(r)));
        return Promise.resolve(fail ? { error: new Error('Count unavailable') } : { data, count: data.length }).then(resolve, reject);
      },
    };
    return q;
  }};
}
const row = (status, fields = {}) => ({ campaign_id: 'campaign', status, ...fields });
const campaign = { id: 'campaign', status: 'sending', created_at: '2026-10-19T08:00:00Z', sent_at: '2026-10-19T09:00:00Z' };
const now = Date.parse('2026-10-19T10:00:00Z');

test('Fast Track shape: exact 4991-row partition; no provider call or write', async t => {
  const rows = [
    ...Array.from({ length: 4826 }, () => row('sent')),
    ...Array.from({ length: 149 }, () => row('cancelled')),
    row('unsubscribed'),
    ...Array.from({ length: 15 }, () => row('processing')),
    row('failed', { campaign_id: 'other-campaign' }),
  ];
  const db = database(rows);
  const summary = await readCampaignDeliverySummary(db, campaign, now);
  assert.deepEqual([summary.sent, summary.excluded, summary.failed, summary.processing, summary.queued], [4826, 150, 0, 15, 0]);
  assert.equal(summary.reconciliationAlert.count, 15);
  assert.ok(db.reads.every(r => r.options.head && r.options.count === 'exact'));
  const original = supabase.from;
  t.after(() => { supabase.from = original; });
  supabase.from = db.from;
  const result = await getCampaignSendOutcome('campaign');
  assert.equal(result.status, 'sending');
  assert.equal(result.complete, false);
  assert.equal(result.excluded, 150);
  assert.equal(result.awaitingReconciliation, 15);
  const feedback = getCampaignSendFeedback(result);
  assert.match(feedback.message, /150 excluded \(skipped, not sent\)/);
  assert.match(feedback.message, /15 awaiting reconciliation/);
  assert.doesNotMatch(feedback.message, /15 emails still queued/);
});

test('post-send events stay sent, unsent exclusions stay separate, mixed queued/processing/failed', async () => {
  const summary = await readCampaignDeliverySummary(database([
    row('sent'), row('delivered'), row('opened'), row('clicked'), row('bounced'), row('complained'),
    row('unsubscribed', { sent_at: '2026-10-19' }),
    row('unsubscribed', { mailgun_message_id: 'provider-id' }),
    row('unsubscribed'), row('cancelled'), row('pending'), row('processing'), row('failed'),
  ]), campaign, now);
  assert.deepEqual([summary.sent, summary.excluded, summary.failed, summary.queued, summary.processing], [8, 2, 1, 1, 1]);
});

test('count failures remain errors, not fabricated zeroes', async () => {
  await assert.rejects(readCampaignDeliverySummary(database([], true), campaign), /Count unavailable/);
});

test('stale warnings use explicit campaign-age evidence, never inherited completed_at', () => {
  assert.equal(campaignReconciliationAlert(campaign, 0, now), null);
  assert.equal(campaignReconciliationAlert(campaign, 1, Date.parse('2026-10-19T09:05:00Z')), null);
  const warning = campaignReconciliationAlert({ ...campaign, completed_at: '1999-01-01' }, 15, now);
  assert.match(warning.message, /individual processing start times are not recorded/);
  assert.equal(warning.basis, 'campaign_age');
  for (const sent_at of [null, 'invalid', '2026-10-18', '2026-10-20']) {
    assert.equal(campaignReconciliationAlert({ ...campaign, sent_at }, 1, now).basis, 'unknown_start');
  }
  for (const status of ['paused', 'cancelled', 'sent', 'failed']) {
    assert.ok(campaignReconciliationAlert({ ...campaign, status }, 1, Date.parse('2026-10-19T09:05:00Z')));
  }
});

test('hard-bounce suppression labels never claim recall or a new bounce', () => {
  assert.equal(campaignRecipientLabel(row('cancelled', { error_message: 'Hard-bounced address: campaign sends are paused' })), 'Skipped — hard-bounce suppression');
  assert.equal(campaignRecipientLabel(row('cancelled')), 'Skipped — not sent');
  assert.equal(campaignRecipientLabel(row('unsubscribed')), 'Skipped — consent exclusion');
  assert.equal(campaignRecipientLabel(row('unsubscribed', { sent_at: '2026-10-19' })), 'unsubscribed');
  assert.equal(campaignRecipientLabel(row('processing')), 'Awaiting reconciliation');
});

test('bulk suppression preserves its reason while operator stops do not invent one', async () => {
  const entry = { recipient: { id: 'recipient' } };
  for (const suppressed of [true, false]) {
    const releases = [];
    await finishPreparedCampaignBatch({
      entries: [entry],
      gate: async () => ({ allowed: false, cancelled: true }),
      revalidateBatch: async () => new Map([['recipient', suppressed ? 'cancelled' : 'ready']]),
      release: async (...args) => releases.push(args),
      submit: () => assert.fail('Excluded or stopped recipients must not be submitted'),
    });
    const release = releases.find(([entries]) => entries.length);
    assert.equal(release[1], 'cancelled');
    assert.equal(release[2], suppressed ? 'Hard-bounced address: campaign sends are paused' : undefined);
  }
});
