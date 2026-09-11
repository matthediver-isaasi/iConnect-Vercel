import test from 'node:test';
import assert from 'node:assert/strict';
import { sendMembershipInvoiceEmail } from './membershipInvoiceEmail.js';
import { sendTenantEmail } from './tenantEmailService.js';

test('sendTenantEmail classifies a raw Mailgun transport failure as ambiguous', async () => {
  const providerError = Object.assign(new Error('ECONNRESET'), {
    type: 'MailgunAPIError',
    status: 400,
    details: 'socket hang up after request transmission',
  });
  const result = await sendTenantEmail({
    tenantId: null,
    to: 'recipient@example.test',
    subject: 'test',
    html: '<p>test</p>',
    mailgunClient: {
      messages: {
        create: async () => { throw providerError; },
      },
    },
  });
  assert.deepEqual(
    { success: result.success, ambiguousEffect: result.ambiguousEffect },
    { success: false, ambiguousEffect: true },
  );
});

test('membership invoice email returns ambiguous failure when its resolved tenant-email response is unconfirmed', async () => {
  const client = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        single: async () => ({ data: table === 'tenant' ? { name: 'Tenant' } : null, error: null }),
        insert: async () => ({ data: null, error: null }),
      };
    },
  };
  const result = await sendMembershipInvoiceEmail({
    tenantId: 'tenant',
    organizationId: 'organization',
    organizationName: 'Organization',
    membershipYear: '2026',
    finalCost: 100,
    currency: 'GBP',
    tierLabel: 'Standard',
    xeroInvoiceId: 'invoice',
    client,
    resolveRecipients: async () => ({ recipients: ['recipient@example.test'], usedFallback: false }),
    buildInbox: async () => null,
    send: async () => ({ success: false, ambiguousEffect: true, error: 'response lost' }),
  });
  assert.equal(result.success, false);
  assert.equal(result.ambiguousEffect, true);
});