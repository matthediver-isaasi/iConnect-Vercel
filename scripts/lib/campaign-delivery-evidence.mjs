import assert from 'node:assert/strict';

const normalizeId = value => String(value || '').replace(/^<|>$/g, '');
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const timestamp = value => {
  assert.equal(typeof value, 'number', 'Provider timestamp must be numeric');
  assert.ok(Number.isFinite(value) && value > 0, 'Invalid provider timestamp');
  return new Date(value * 1000).toISOString();
};

// Read-only evidence classification: no provider calls, app imports, or retry path.
// An empty history never establishes that a message was not submitted.
export function verifyDeliveredCampaignMessage({ campaign, recipient, events, message, linkHost }) {
  assert.equal(recipient.campaign_id, campaign.id, 'Recipient belongs to another campaign');
  assert.ok(Array.isArray(events) && events.length, 'No positive delivery evidence');
  assert.ok(Array.isArray(message['message-headers']), 'Stored message headers missing');
  const header = name => {
    const matches = message['message-headers'].filter(([key]) => key.toLowerCase() === name.toLowerCase());
    assert.equal(matches.length, 1, `Missing/ambiguous ${name} header`);
    return matches[0][1];
  };
  const messageId = normalizeId(header('Message-Id'));
  assert.ok(messageId, 'Message ID missing');
  assert.equal(header('Subject'), campaign.subject, 'Subject mismatch');
  const recipients = Array.isArray(message.recipients) ? message.recipients : [message.recipients];
  assert.deepEqual(recipients.map(normalizeEmail), [normalizeEmail(recipient.email)], 'Envelope recipient mismatch');
  const hrefs = [...String(message['body-html'] || '').matchAll(/href="([^"]*)"/g)].map(match => match[1]);
  const unsubscribeLinks = [...header('List-Unsubscribe').matchAll(/<([^>]+)>/g)].map(match => match[1]);
  const paths = new Set();
  let unsubscribeProof = false;
  for (const [href, fromHeader] of [...hrefs.map(href => [href, false]), ...unsubscribeLinks.map(href => [href, true])]) {
    let url;
    try { url = new URL(href.replaceAll('&amp;', '&')); } catch { continue; }
    if (url.protocol !== 'https:' || url.hostname !== linkHost ||
        !['/api/track/click', '/email-preferences', '/api/email-campaigns/unsubscribe'].includes(url.pathname)) continue;
    const tokens = url.searchParams.getAll('t');
    assert.equal(tokens.length, 1, 'Missing/ambiguous identity token');
    const identity = Buffer.from(tokens[0], 'base64url').toString().split(':');
    assert.equal(identity.length, 3, 'Invalid campaign identity');
    assert.deepEqual(identity.slice(0, 2), [campaign.id, recipient.id], 'Embedded campaign/recipient mismatch');
    assert.match(identity[2], /^\d+$/, 'Invalid link index');
    paths.add(url.pathname);
    if (fromHeader && url.pathname === '/api/email-campaigns/unsubscribe') unsubscribeProof = true;
  }
  assert.ok(unsubscribeProof && paths.has('/api/track/click'), 'Exact campaign/recipient proof missing');
  const matching = events.filter(event => normalizeId(event.message?.headers?.['message-id']) === messageId);
  assert.ok(matching.length, 'Stored message has no corresponding events');
  const ids = new Set();
  for (const event of matching) {
    assert.equal(normalizeEmail(event.recipient), normalizeEmail(recipient.email), 'Event recipient mismatch');
    assert.ok(event.id && !ids.has(event.id), 'Missing/duplicate provider event ID');
    ids.add(event.id);
    timestamp(event.timestamp);
    assert.ok(['accepted', 'delivered', 'opened', 'clicked'].includes(event.event), 'Conflicting delivery outcome requires manual review');
  }
  // Do not ignore a second accepted message just because its ID differs.
  assert.equal(events.filter(event => event.event === 'accepted').length, 1, 'Multiple/absent submissions require manual review');
  const accepted = matching.filter(event => event.event === 'accepted');
  const delivered = matching.filter(event => event.event === 'delivered');
  assert.equal(accepted.length, 1, 'Accepted evidence missing');
  assert.equal(delivered.length, 1, 'Delivered evidence missing/ambiguous');
  for (const event of [accepted[0], delivered[0]]) {
    assert.equal(event.message?.headers?.subject, campaign.subject, 'Event subject mismatch');
    assert.equal(event.flags?.['is-test-mode'], false, 'Real delivery mode not established');
    assert.equal(event.flags?.['is-authenticated'], true, 'Authenticated provider acceptance missing');
  }
  assert.ok(accepted[0].timestamp * 1000 >= Date.parse(recipient.created_at), 'Acceptance predates recipient');
  assert.ok(accepted[0].timestamp * 1000 >= Date.parse(campaign.sent_at), 'Acceptance predates campaign');
  assert.ok(delivered[0].timestamp >= accepted[0].timestamp, 'Delivery predates acceptance');
  const opens = matching.filter(event => event.event === 'opened').sort((a, b) => a.timestamp - b.timestamp);
  assert.ok(opens.every(event => event.timestamp >= delivered[0].timestamp), 'Open predates delivery');
  return {
    recipientId: recipient.id, messageId, sentAt: timestamp(accepted[0].timestamp),
    deliveredAt: timestamp(delivered[0].timestamp), deliveryIsTest: false,
    openedAt: opens.length ? timestamp(opens[0].timestamp) : null, openCount: opens.length,
    // Provider clicks are evidence only, never a source of iConnect click counts.
    events: matching,
  };
}
