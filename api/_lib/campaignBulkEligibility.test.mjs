import test from 'node:test';
import assert from 'node:assert/strict';
import { bulkRecipientEligibility } from './campaignBulkEligibility.js';
import { finishPreparedCampaignBatch } from './campaignBulkDrain.js';

function fixture({ delay = 0, broken = null } = {}) {
  const campaign = { tenant_id: 'tenant', preparation_generation: 'generation', communication_category_id: 'category' };
  const entries = Array.from({ length: 100 }, (_, i) => ({ recipient: {
    id: `r${i}`, member_id: `m${i}`, email: `person${i}@example.invalid`,
  } }));
  const data = {
    campaign_preparation_recipient: entries.map(e => ({ generation: 'generation', recipient_id: e.recipient.id, recipient: {} })),
    member: entries.map(e => ({ tenant_id: 'tenant', id: e.recipient.member_id, email: e.recipient.email, login_enabled: true })),
    member_communication_preference: entries.map(e => ({ tenant_id: 'tenant', member_id: e.recipient.member_id, category_id: 'category', is_subscribed: true })),
    email_address_bounce: [], email_unsubscribe: [],
  };
  let calls = 0;
  const db = { from(table) {
    const filters = [];
    return {
      select() { return this; },
      eq(k, v) { filters.push(r => r[k] === v); return this; },
      is(k, v) { filters.push(r => r[k] === v); return this; },
      in(k, values) { filters.push(r => values.includes(r[k])); return this; },
      filter(k, operator, pattern) { assert.equal(operator, 'imatch'); const regex = new RegExp(pattern, 'i'); filters.push(r => regex.test(r[k])); return this; },
      or() { return this; },
      async limit(cap) {
        calls++; if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        return table === broken ? { error: { code: 'test-failure' } } : { data: data[table].filter(r => filters.every(f => f(r))).slice(0, cap) };
      },
    };
  }};
  return { campaign, entries, data, db, calls: () => calls };
}

test('100 recipients need nine bounded parallel reads, not hundreds', async () => {
  const f = fixture();
  const states = await bulkRecipientEligibility(f.db, f.entries, f.campaign, 'tenant');
  assert.equal(f.calls(), 9);
  assert.equal([...states.values()].filter(v => v === 'ready').length, 100);
});

test('fresh opt-outs, missing members, changed emails, category consent and bounces are enforced', async () => {
  const f = fixture();
  f.data.member[0].communications_opted_out_all = true;
  f.data.member = f.data.member.filter(r => r.id !== 'm1');
  f.data.member[2].email = 'changed@example.invalid';
  f.data.member_communication_preference = f.data.member_communication_preference.filter(r => r.member_id !== 'm4');
  f.data.email_unsubscribe.push({ tenant_id: 'tenant', email: 'PERSON5@EXAMPLE.INVALID', unsubscribe_type: 'all' });
  f.data.email_address_bounce.push({ tenant_id: 'tenant', email: 'person6@example.invalid', resolved_at: null });
  const states = await bulkRecipientEligibility(f.db, f.entries, f.campaign, 'tenant');
  for (const id of ['r0', 'r1', 'r3', 'r4', 'r5']) assert.equal(states.get(id), 'unsubscribed');
  assert.equal(states.get('r6'), 'cancelled');
  assert.equal(states.get('r99'), 'ready');
  f.data.member[0].communications_opted_out_all = false;
  assert.equal((await bulkRecipientEligibility(f.db, f.entries, f.campaign, 'tenant')).get('r0'), 'ready');
});

test('consent bypass does not bypass hard-bounce suppression', async () => {
  const f = fixture();
  f.data.campaign_preparation_recipient[0].recipient.bypass_opt_out = true;
  f.data.member[0].communications_opted_out_all = true;
  assert.equal((await bulkRecipientEligibility(f.db, f.entries, f.campaign, 'tenant')).get('r0'), 'ready');
  f.data.email_address_bounce.push({ tenant_id: 'tenant', email: 'person0@example.invalid', resolved_at: null });
  assert.equal((await bulkRecipientEligibility(f.db, f.entries, f.campaign, 'tenant')).get('r0'), 'cancelled');
});

test('literal star addresses cannot match somebody else', async () => {
  const f = fixture();
  f.entries[0].recipient.email = 'a*b@example.invalid'; f.data.member[0].email = 'a*b@example.invalid';
  f.data.email_unsubscribe.push({ tenant_id: 'tenant', email: 'AXb@example.invalid', unsubscribe_type: 'all' });
  assert.equal((await bulkRecipientEligibility(f.db, f.entries, f.campaign, 'tenant')).get('r0'), 'ready');
  f.data.email_unsubscribe.push({ tenant_id: 'tenant', email: 'A*B@example.invalid', unsubscribe_type: 'all' });
  assert.equal((await bulkRecipientEligibility(f.db, f.entries, f.campaign, 'tenant')).get('r0'), 'unsubscribed');
});

for (const reason of ['read error', 'missing provenance', 'invalid provenance', 'overflow', 'tenant mismatch']) test(`fail closed on ${reason}`, async () => {
  const f = fixture({ broken: reason === 'read error' ? 'member' : null });
  if (reason === 'missing provenance') f.data.campaign_preparation_recipient.pop();
  if (reason === 'invalid provenance') f.data.campaign_preparation_recipient[0].recipient = null;
  if (reason === 'overflow') f.data.email_unsubscribe = Array.from({ length: 201 }, () => ({ tenant_id: 'tenant', email: 'person0@example.invalid', unsubscribe_type: 'all' }));
  await assert.rejects(bulkRecipientEligibility(f.db, f.entries, f.campaign, reason === 'tenant mismatch' ? 'other' : 'tenant'));
});

test('slow database reads still leave room to submit within the final 12-second budget', async () => {
  const f = fixture({ delay: 400 });
  let submissions = 0;
  const result = await finishPreparedCampaignBatch({
    entries: f.entries, deadline: Date.now() + 12000,
    revalidateBatch: entries => bulkRecipientEligibility(f.db, entries, f.campaign, 'tenant'),
    gate: async () => ({ allowed: true }), release: async () => assert.fail('Must make progress, not release everyone'),
    submit: async entries => { submissions++; assert.equal(entries.length, 100); return { success: true, messageId: 'fixture' }; },
    persist: async () => {},
  });
  assert.equal(submissions, 1);
  assert.equal(result.sent, 100);
});

test('pause after batch checking prevents submission', async () => {
  const f = fixture(); let released = 0;
  await finishPreparedCampaignBatch({
    entries: f.entries, deadline: Date.now() + 12000,
    revalidateBatch: entries => bulkRecipientEligibility(f.db, entries, f.campaign, 'tenant'),
    gate: async () => ({ allowed: false, paused: true }), release: async entries => { released += entries.length; },
    submit: async () => assert.fail('Paused campaign must not send'), persist: async () => assert.fail(),
  });
  assert.equal(released, 100);
});
