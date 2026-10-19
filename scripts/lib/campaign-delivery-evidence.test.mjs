import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDeliveredCampaignMessage } from './campaign-delivery-evidence.mjs';

function fixture() {
  const token = Buffer.from('campaign:recipient:0').toString('base64url');
  const flags = { 'is-test-mode': false, 'is-authenticated': true };
  return {
    campaign: { id: 'campaign', subject: 'Campaign subject', sent_at: '2026-10-19T12:00:00Z' },
    recipient: { id: 'recipient', campaign_id: 'campaign', email: 'person@example.test', created_at: '2026-10-19T12:00:00Z' },
    linkHost: 'example.test',
    message: {
      recipients: 'person@example.test',
      'message-headers': [
        ['Message-Id', '<provider-message>'], ['Subject', 'Campaign subject'],
        ['List-Unsubscribe', `<https://example.test/api/email-campaigns/unsubscribe?t=${token}>`],
      ],
      'body-html': `<a href="https://example.test/api/track/click?t=${token}&amp;url=https%3A%2F%2Fexample.test">Link</a>`,
    },
    events: ['accepted', 'delivered', 'opened', 'clicked'].map((event, index) => ({
      id: `event-${index}`, event, timestamp: Date.parse('2026-10-19T12:01:00Z') / 1000 + index,
      recipient: 'person@example.test', flags,
      message: { headers: { 'message-id': 'provider-message', subject: 'Campaign subject' } },
    })),
  };
}
test('exact message, envelope, campaign and recipient proof yields a delivery-only repair', () => {
  const repair = verifyDeliveredCampaignMessage(fixture());
  assert.equal(repair.messageId, 'provider-message');
  assert.equal(repair.deliveryIsTest, false);
  assert.equal(repair.openCount, 1);
  assert.equal(repair.events.length, 4);
  assert.equal('clickCount' in repair, false);
  assert.equal('retry' in repair, false);
});
for (const [name, mutate] of [
  ['empty history never authorizes retry', f => { f.events = []; }],
  ['same email and subject but no campaign proof', f => { f.message['body-html'] = ''; }],
  ['wrong campaign in stored link', f => { f.message['body-html'] = f.message['body-html'].replace(Buffer.from('campaign:recipient:0').toString('base64url'), Buffer.from('other:recipient:0').toString('base64url')); }],
  ['wrong recipient in stored link', f => { f.message['body-html'] = f.message['body-html'].replace(Buffer.from('campaign:recipient:0').toString('base64url'), Buffer.from('campaign:other:0').toString('base64url')); }],
  ['foreign link host', f => { f.linkHost = 'another.test'; }],
  ['wrong event recipient', f => { f.events[0].recipient = 'other@example.test'; }],
  ['different message ID', f => { f.events[0].message.headers['message-id'] = 'other-message'; }],
  ['duplicate provider event ID', f => { f.events[1].id = f.events[0].id; }],
  ['missing live mode', f => { delete f.events[0].flags['is-test-mode']; }],
  ['test mode', f => { f.events[0].flags['is-test-mode'] = true; }],
  ['acceptance is not proof of delivery', f => { f.events = [f.events[0]]; }],
  ['conflicting event', f => { f.events[2].event = 'failed'; }],
  ['invalid timestamp', f => { f.events[0].timestamp = 'not a timestamp'; }],
  ['duplicate header', f => { f.message['message-headers'].push(['Message-Id', '<different>']); }],
  ['different envelope recipient', f => { f.message.recipients = 'other@example.test'; }],
  ['another accepted submission', f => { f.events.push({ ...f.events[0], id: 'second', message: { headers: { 'message-id': 'other-message' } } }); }],
  ['acceptance before campaign', f => { f.campaign.sent_at = '2026-10-20T00:00:00Z'; }],
  ['recipient belongs to another campaign', f => { f.recipient.campaign_id = 'other'; }],
]) {
  test(name, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => verifyDeliveredCampaignMessage(input));
  });
}
