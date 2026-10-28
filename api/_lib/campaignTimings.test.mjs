import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignTimingEvidence, readCampaignTimings } from './campaignTimings.js';

const at = minute => `2026-10-21T10:${String(minute).padStart(2, '0')}:00.000Z`;
const campaign = {
  id: 'campaign-a', status: 'sent', created_at: at(0), scheduled_at: at(5),
  sent_at: at(10), completed_at: at(30), preparation_generation: 'generation-a',
};

// Deliberately exposes only read methods; a mutation or extra query fails.
function fixture({ parent = campaign, parentError, prep, first = at(15), last = at(25), errors = {} } = {}) {
  const reads = [];
  let parentResolved = false;
  const db = {
    from(table) {
      if (table !== 'email_campaign') assert.equal(parentResolved, true, 'child read preceded parent authorization');
      const read = { table, filters: [] };
      reads.push(read);
      return {
        select(fields) { read.fields = fields; return this; },
        eq(...args) { read.filters.push(args); return this; },
        not(...args) { read.not = args; return this; },
        order(field, options) { read.order = [field, options]; return this; },
        limit(value) { read.limit = value; return this; },
        async maybeSingle() {
          if (table === 'email_campaign') {
            assert.deepEqual(read.filters, [['id', 'campaign-a'], ['tenant_id', 'tenant-a']]);
            parentResolved = true;
            return { data: parent, error: parentError };
          }
          if (table === 'campaign_preparation') {
            assert.deepEqual(read.filters, [['id', 'generation-a'], ['campaign_id', 'campaign-a'], ['tenant_id', 'tenant-a']]);
            return { data: prep, error: errors.prep };
          }
          assert.equal(table, 'email_campaign_recipient');
          assert.deepEqual(read.filters, [['campaign_id', 'campaign-a']]);
          assert.deepEqual(read.not, ['sent_at', 'is', null]);
          assert.equal(read.limit, 1);
          assert.equal(read.order[0], 'sent_at');
          const key = read.order[1].ascending ? 'first' : 'last';
          return { data: { sent_at: key === 'first' ? first : last }, error: errors[key] };
        },
      };
    },
  };
  return { db, reads };
}

test('timings authorize tenant-scoped parent before generation and bounded first/last child reads', async () => {
  const prep = { phase: 'complete', completed_at: at(14) };
  const { db, reads } = fixture({ prep });
  const result = await readCampaignTimings(db, 'campaign-a', 'tenant-a');
  assert.deepEqual(result.campaign.preparation, prep);
  assert.equal(result.timings.preparation_duration_ms, 4 * 60000);
  assert.equal(result.timings.send_duration_ms, 10 * 60000);
  assert.equal(result.timings.overall_duration_ms, 10 * 60000);
  assert.equal(result.timings.first_recipient_sent_at, at(15));
  assert.equal(result.timings.last_recipient_sent_at, at(25));
  assert.equal(reads.length, 4);
});

test('absent or unauthorized parent returns null without any child reads', async () => {
  const { db, reads } = fixture({ parent: null });
  assert.equal(await readCampaignTimings(db, 'campaign-a', 'tenant-a'), null);
  assert.deepEqual(reads.map(r => r.table), ['email_campaign']);
});

test('parent query errors propagate without child reads', async () => {
  const error = { code: '42501', message: 'Denied' };
  const { db, reads } = fixture({ parentError: error });
  await assert.rejects(readCampaignTimings(db, 'campaign-a', 'tenant-a'), e => e === error);
  assert.equal(reads.length, 1);
});

test('all child query errors propagate rather than returning partial or fabricated timings', async () => {
  for (const key of ['prep', 'first', 'last']) {
    const error = { code: '42703', message: `Missing ${key} evidence` };
    const { db } = fixture({ errors: { [key]: error } });
    await assert.rejects(readCampaignTimings(db, 'campaign-a', 'tenant-a'), e => e === error);
  }
});

test('campaign without preparation generation never reads preparation', async () => {
  const { db, reads } = fixture({ parent: { ...campaign, preparation_generation: null } });
  const result = await readCampaignTimings(db, 'campaign-a', 'tenant-a');
  assert.equal(reads.some(r => r.table === 'campaign_preparation'), false);
  assert.equal(result.timings.preparation_started_at, null);
  assert.equal(result.timings.preparation_duration_ms, null);
});

test('durations use first and last successes, independently of workflow completion', () => {
  const timings = campaignTimingEvidence(campaign, { phase: 'complete', completed_at: at(14) }, at(15), at(25));
  assert.equal(timings.started_at, at(10));
  assert.equal(timings.scheduled_at, at(5));
  assert.equal(timings.completed_at, at(30));
  assert.equal(timings.send_duration_ms, 600000);
  assert.equal(timings.overall_duration_ms, 600000);
  assert.match(timings.notes.join(' '), /gaps between successful sends/);
});

test('missing, malformed and chronologically invalid completion never invent duration', () => {
  for (const completed_at of [null, undefined, '', 'invalid', at(1), at(9)]) {
    const timings = campaignTimingEvidence({ ...campaign, completed_at }, {
      phase: 'complete', completed_at, updated_at: at(40),
    }, at(15), at(25));
    assert.equal(timings.completed_at, null);
    assert.equal(timings.preparation_completed_at, null);
    assert.equal(timings.preparation_duration_ms, null);
    assert.equal(timings.send_duration_ms, 600000);
    assert.equal(timings.overall_duration_ms, 600000);
    assert.match(timings.notes.join(' '), /last update is not used/);
  }
});

test('ongoing states ignore stale campaign completion; unfinished preparation ignores saved completion', () => {
  for (const status of ['draft', 'scheduled', 'preparing', 'sending', 'paused']) {
    const timings = campaignTimingEvidence({ ...campaign, status }, { phase: 'materializing', completed_at: at(14) }, at(15), at(25));
    assert.equal(timings.completed_at, null);
    assert.equal(timings.preparation_completed_at, null);
    assert.equal(timings.send_duration_ms, 600000);
    assert.equal(timings.overall_duration_ms, 600000);
    assert.equal(timings.started_at, ['draft', 'scheduled'].includes(status) ? null : at(10));
  }
});

test('terminal failure/cancellation retain actual completion but missing successful sends stay unknown', () => {
  for (const status of ['sent', 'failed', 'cancelled']) {
    const timings = campaignTimingEvidence({ ...campaign, status }, null, null, null);
    assert.equal(timings.completed_at, at(30));
    assert.equal(timings.overall_duration_ms, null);
    assert.equal(timings.send_duration_ms, null);
  }
});

test('recipient evidence before this campaign run or invalid timestamps is ignored', () => {
  for (const value of ['invalid', at(1), at(9)]) {
    const timings = campaignTimingEvidence(campaign, null, value, value);
    assert.equal(timings.first_recipient_sent_at, null);
    assert.equal(timings.last_recipient_sent_at, null);
    assert.equal(timings.send_duration_ms, null);
  }
  const timings = campaignTimingEvidence({ ...campaign, completed_at: at(12) }, null, at(15), at(25));
  assert.equal(timings.send_duration_ms, 600000, 'early completion must not suppress successful-send evidence');
});

test('cancelled campaign without completion retains duration; single success is zero; missing or reversed evidence stays unknown', () => {
  const cancelled = {...campaign, status:'cancelled', completed_at:null};
  assert.equal(campaignTimingEvidence(cancelled,null,at(15),at(25)).overall_duration_ms,600000);
  assert.equal(campaignTimingEvidence(cancelled,null,at(15),at(15)).send_duration_ms,0);
  for(const [first,last] of [[null,at(25)],[at(15),null],[at(25),at(15)]]){
    assert.equal(campaignTimingEvidence(cancelled,null,first,last).send_duration_ms,null);
  }
});
