import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverMailgunMessage, mailgunSuccessMetadata, sendEmail } from './emailService.js';

test('Mailgun boundary sends exactly one final domain and envelope', async () => {
  const calls = [];
  const client = {
    messages: {
      async create(domain, message) {
        calls.push({ domain, message });
        return { id: '<mailgun-id@example.test>' };
      },
    },
  };
  const message = {
    from: 'Tenant <noreply@mail.tenant.test>',
    to: ['member@example.test'],
    cc: ['copy@example.test'],
    subject: 'Subject',
    html: '<p>Message</p>',
    text: 'Message',
  };

  const result = await deliverMailgunMessage(client, 'mail.tenant.test', message);
  assert.deepEqual(calls, [{ domain: 'mail.tenant.test', message }]);
  assert.deepEqual(result, { id: '<mailgun-id@example.test>' });
  const finalMessage = {
      ...message,
      from: 'ICONN <noreply@mail.iconn.app>',
      subject: 'Rendered subject',
      html: '<p>Rendered body</p><footer>Rendered footer</footer>',
      text: 'Rendered body',
  };
  assert.deepEqual(
    mailgunSuccessMetadata(result, 'mail.iconn.app', finalMessage, true),
    {
      success: true,
      messageId: '<mailgun-id@example.test>',
      domain: 'mail.iconn.app',
      fromAddress: 'ICONN <noreply@mail.iconn.app>',
      provider: 'mailgun',
      fallback: true,
    },
  );
  assert.deepEqual(
    mailgunSuccessMetadata(result, 'mail.iconn.app', finalMessage, true, true),
    {
      success: true,
      messageId: '<mailgun-id@example.test>',
      domain: 'mail.iconn.app',
      fromAddress: 'ICONN <noreply@mail.iconn.app>',
      provider: 'mailgun',
      fallback: true,
      renderedSubject: 'Rendered subject',
      renderedHtml: '<p>Rendered body</p><footer>Rendered footer</footer>',
      renderedText: 'Rendered body',
    },
  );
});

test('sendEmail omits rendered message content unless a trusted caller opts in', async () => {
  const dependencies = {
    client: {
      messages: {
        create: async () => ({ id: '<safe-default@mailgun.test>' }),
      },
    },
    defaultDomain: 'mail.iconn.test',
    defaultFrom: 'ICONN <noreply@mail.iconn.test>',
    getTenantEmailConfig: async () => null,
    getEmailFooter: async () => null,
    resolveTransactionalPreferenceTokens: async payload => payload,
  };
  const result = await sendEmail({
    to: 'member@example.test',
    subject: 'CONFIDENTIAL_SUBJECT',
    html: '<p>CONFIDENTIAL_BODY</p>',
    text: 'CONFIDENTIAL_TEXT',
    tenantId: 'tenant-a',
  }, dependencies);

  assert.deepEqual(result, {
    success: true,
    messageId: '<safe-default@mailgun.test>',
    domain: 'mail.iconn.test',
    fromAddress: 'ICONN <noreply@mail.iconn.test>',
    provider: 'mailgun',
  });
  assert.equal(JSON.stringify(result).includes('CONFIDENTIAL'), false);
});