import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBulkEnvelope, bulkCampaignCompatible, newCampaignTransport } from './campaignBulkTransport.js';
import { finishPreparedCampaignBatch } from './campaignBulkDrain.js';
import { sendEmail, sendPreparedCampaignBatch } from './emailService.js';
import { lookupRecipient } from './mailgunEventSync.js';

const message = i => ({ domain: 'mail.example.invalid', messageData: {
  from: 'Sender <sender@example.invalid>', to: [`person${i}@example.invalid`],
  subject: `Hello ${i}`, html: `<p>Personal ${i}</p><a href="https://example.invalid/preferences/${i}">Preferences</a>`,
  text: `Personal ${i}`, 'h:List-Unsubscribe': `<https://example.invalid/unsubscribe/${i}>`,
  'h:List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'o:testmode': 'yes',
}});

test('compatible live and test campaigns automatically batch regardless of legacy rollout flags', () => {
  assert.equal(newCampaignTransport({ is_test_mode: true }, {}), 'mailgun_batch_v1');
  const env = { CAMPAIGN_MAILGUN_BATCH_ENABLED: 'true' };
  assert.equal(newCampaignTransport({ is_test_mode: true }, env), 'mailgun_batch_v1');
  assert.equal(newCampaignTransport({ is_test_mode: false }, env), 'mailgun_batch_v1');
  assert.equal(newCampaignTransport({}, { ...env, CAMPAIGN_MAILGUN_BATCH_LIVE_ENABLED: 'true' }), 'mailgun_batch_v1');
  assert.equal(newCampaignTransport({}, { CAMPAIGN_MAILGUN_BATCH_ENABLED: 'false', CAMPAIGN_MAILGUN_BATCH_LIVE_ENABLED: 'false' }), 'mailgun_batch_v1');
  for (const html_content of ['{{survey_url}}', '[[survey_link]]', '{{event_survey_list}}']) {
    assert.equal(newCampaignTransport({ html_content }), 'individual');
  }
});

test('100 recipients use one private envelope with separate bodies and unsubscribe destinations', async () => {
  const messages = Array.from({ length: 100 }, (_, i) => message(i));
  let calls = 0;
  const result = await sendPreparedCampaignBatch('campaign', messages, Date.now() + 20000, {
    client: { messages: { create: async (domain, data) => {
      calls++;
      assert.equal(domain, 'mail.example.invalid');
      assert.equal(data.to.length, 100);
      assert.equal(data['o:testmode'], 'yes');
      assert.equal(data['v:iconn_campaign_id'], 'campaign');
      const variables = JSON.parse(data['recipient-variables']);
      for (let i = 0; i < 100; i++) {
        const v = variables[`person${i}@example.invalid`];
        assert.equal(v.field0, `Hello ${i}`);
        assert.equal(v.field1, messages[i].messageData.html);
        assert.equal(v.field3, messages[i].messageData['h:List-Unsubscribe']);
      }
      return { id: '<batch-id>' };
    } } },
  });
  assert.equal(calls, 1);
  assert.equal(result.messageId, 'batch-id');
});

test('preparation composes footer and preferences without calling the provider', async () => {
  const result = await sendEmail({ to: 'member@example.invalid', tenantId: 'tenant',
    subject: 'Hello', html: '<p>Body</p>', testMode: true, resolveTransactionalPreferences: false,
    campaignPreferences: { preferencesUrl: 'https://example.invalid/personal' },
  }, { prepareOnly: true,
    client: { messages: { create: () => assert.fail('Must not submit during preparation') } },
    getTenantEmailConfig: async () => null,
    getEmailFooter: async () => '<footer>Footer {{preferences_url}}</footer>',
    replaceSocialPlaceholdersInFooter: async html => html,
  });
  assert.ok(result.prepared.messageData.html.includes('Footer'));
  assert.ok(result.prepared.messageData.html.includes('https://example.invalid/personal'));
  assert.equal(result.prepared.messageData['o:testmode'], 'yes');
});

for (const [label, mutate] of [
  ['duplicate addresses', rows => { rows[1].messageData.to = rows[0].messageData.to; }],
  ['mixed domains', rows => { rows[1].domain = 'other.invalid'; }],
  ['mixed test flags', rows => { delete rows[1].messageData['o:testmode']; }],
  ['cc', rows => { rows[0].messageData.cc = ['other@example.invalid']; }],
  ['nested tokens', rows => { rows[0].messageData.html = '%recipient.secret%'; }],
  ['oversize payload', rows => { rows[0].messageData.html = 'a'.repeat(8_000_001); }],
]) test(`rejects ${label} before submission`, async () => {
  const rows = [message(1), message(2)]; mutate(rows);
  const result = await sendPreparedCampaignBatch('campaign', rows, Date.now() + 20000, {
    client: { messages: { create: () => assert.fail('Must not submit invalid envelope') } },
  });
  assert.equal(result.notSubmitted, true);
});

for (const campaign of [{ event_id: 'event' }, { event_survey_context: { event_id: 'event' } },
  { html_content: '{{event_survey_list}}' }, { member_group_id: 'group' },
  { attachments: [{}] }, { subject: '[[booking.id]]' }]) {
  test(`complex campaign falls back: ${JSON.stringify(campaign)}`, () => {
    assert.equal(bulkCampaignCompatible(campaign), false);
  });
}
test('ordinary newsletter is compatible', () => assert.equal(bulkCampaignCompatible({ html_content: 'Hello {{first_name}}' }), true));
test('ordinary survey wording and an empty context do not disable newsletter batching', () => {
  assert.equal(bulkCampaignCompatible({ html_content: '<p>Read our survey results</p>', event_survey_context: {} }), true);
});

function fixture() {
  const entries = [0, 1, 2].map(id => ({ id, status: 'processing' }));
  let calls = 0;
  const options = { entries, deadline: 30000, now: () => 0,
    gate: async () => ({ allowed: true }), revalidate: async () => 'ready',
    release: async (rows, status = 'pending') => rows.forEach(row => { if (row.status === 'processing') row.status = status; }),
    submit: async () => { calls++; return { success: true, messageId: 'batch' }; },
    persist: async (rows, values) => rows.forEach(row => Object.assign(row, values)),
  };
  return { entries, options, calls: () => calls };
}
test('records accepted batch once for all recipients', async () => {
  const f = fixture(); const result = await finishPreparedCampaignBatch(f.options);
  assert.equal(f.calls(), 1); assert.equal(result.sent, 3);
  assert.ok(f.entries.every(row => row.mailgun_message_id === 'batch'));
});
test('fresh opt-out and bounce exclusions do not reach provider', async () => {
  const f = fixture();
  await finishPreparedCampaignBatch({ ...f.options, revalidate: async entry => ['ready', 'unsubscribed', 'cancelled'][entry.id],
    submit: async rows => { assert.deepEqual(rows.map(r => r.id), [0]); return { success: true, messageId: 'batch' }; } });
  assert.deepEqual(f.entries.map(r => r.status), ['sent', 'unsubscribed', 'cancelled']);
});
for (const state of ['paused', 'cancelled']) test(`${state} after preparation prevents submission`, async () => {
  const f = fixture();
  await finishPreparedCampaignBatch({ ...f.options, gate: async () => ({ allowed: false, [state]: true }) });
  assert.equal(f.calls(), 0);
  assert.ok(f.entries.every(row => row.status === (state === 'cancelled' ? 'cancelled' : 'pending')));
});
test('deadline releases untouched entries', async () => {
  const f = fixture(); await finishPreparedCampaignBatch({ ...f.options, deadline: 7000 });
  assert.equal(f.calls(), 0); assert.ok(f.entries.every(r => r.status === 'pending'));
});
for (const failure of ['ambiguous', 'persistence', 'throw']) test(`${failure} never requeues a possibly accepted batch`, async () => {
  const f = fixture();
  const result = await finishPreparedCampaignBatch({ ...f.options,
    submit: async () => { if (failure === 'throw') throw Error('Unknown'); return failure === 'ambiguous'
      ? { success: false, ambiguousEffect: true } : { success: true, messageId: 'batch' }; },
    persist: async () => { throw Error('Database unavailable'); },
  });
  assert.equal(result.sent, 0); assert.ok(f.entries.every(row => row.status === 'processing'));
});
test('429 remains visible and is not automatically requeued', async () => {
  const f = fixture();
  const result = await finishPreparedCampaignBatch({ ...f.options,
    submit: async () => ({ success: false, rateLimited: true }) });
  assert.equal(result.stopReason, 'rate_limit'); assert.ok(f.entries.every(r => r.status === 'failed'));
});
test('bulk tracking resolves shared message ID to the matching address', () => {
  const a = { id: 'a', email: 'a@example.invalid' }, b = { id: 'b', email: 'b@example.invalid' };
  const ids = new Map([['batch', null], ['batch:a@example.invalid', a], ['batch:b@example.invalid', b]]);
  assert.equal(lookupRecipient('batch', b.email, ids, new Map()), b);
  assert.equal(lookupRecipient('batch', a.email, ids, new Map()), a);
  assert.equal(lookupRecipient('batch', null, ids, new Map()), null);
});
