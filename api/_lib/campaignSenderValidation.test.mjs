import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { validateCampaignSenderEmail } from './campaignService.js';

test('campaign sender validation accepts a normal mailbox', () => {
  assert.deepEqual(validateCampaignSenderEmail('news@example.com'), { valid: true });
});

test('campaign sender validation rejects the confirmed literal "test" with operator guidance', () => {
  const result = validateCampaignSenderEmail('test');

  assert.equal(result.valid, false);
  assert.match(result.error, /Sender email address "test" is invalid/);
  assert.match(result.error, /Sender Information/);
  assert.match(result.error, /save the campaign/i);
});

test('campaign sender validation rejects empty, malformed, and padded sender values', () => {
  for (const value of [null, undefined, '', 'person@', '@example.com', ' person@example.com ']) {
    assert.equal(validateCampaignSenderEmail(value).valid, false, String(value));
  }
});

test('real send and scheduling validate before campaign mutation', async () => {
  const source = await readFile(new URL('./campaignService.js', import.meta.url), 'utf8');
  const scheduleBody = source.slice(
    source.indexOf('export async function scheduleCampaign'),
    source.indexOf('export async function processScheduledCampaigns'),
  );
  const sendBody = source.slice(
    source.indexOf('export async function sendCampaign'),
    source.indexOf('export async function getCampaignStats'),
  );

  assert.ok(
    scheduleBody.indexOf('validateCampaignSenderEmail(campaign.from_email)')
      < scheduleBody.indexOf(".update({ \n        status: 'scheduled'"),
  );
  assert.ok(
    sendBody.indexOf('validateCampaignSenderEmail(campaign.from_email)')
      < sendBody.indexOf("status: 'preparing'"),
  );
  assert.ok(
    sendBody.indexOf('validateCampaignSenderEmail(campaign.from_email)')
      < sendBody.indexOf('getTargetRecipients(campaign, tenantId)'),
  );
});

test('both campaign test-send handlers validate the stored sender before submission', async () => {
  const sources = await Promise.all([
    readFile(new URL('../email-campaigns/test-send.js', import.meta.url), 'utf8'),
    readFile(new URL('../member-campaigns/test-send.js', import.meta.url), 'utf8'),
  ]);

  for (const [index, source] of sources.entries()) {
    const handlerSource = source.slice(source.indexOf('export default async function handler'));
    const validationIndex = handlerSource.indexOf('validateCampaignSenderEmail(campaign.from_email)');
    const submissionIndex = handlerSource.indexOf(index === 0 ? 'await sendTestToRecipient(' : 'await sendEmail({');
    assert.ok(validationIndex > -1);
    assert.ok(validationIndex < submissionIndex);
    assert.match(handlerSource.slice(validationIndex, submissionIndex), /INVALID_SENDER_EMAIL/);
  }
});

test('EmailCampaignEdit surfaces sender guidance and gates test, send, and schedule actions', async () => {
  const source = await readFile(
    new URL('../../client/src/pages/EmailCampaignEdit.jsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /const senderEmailError = getSenderEmailError\(formData\.from_email\)/);
  assert.match(source, /data-testid="error-from-email"/);
  assert.match(source, /disabled=\{testSending \|\|[^}]+Boolean\(senderEmailError\)\}/);
  assert.match(source, /const canSendCampaign =[\s\S]+!senderEmailError/);
  assert.match(source, /const handleOpenSendConfirm = async \(\) => \{[\s\S]+toast\.error\(senderEmailError\)/);
});