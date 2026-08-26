import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getEmailDomainVerificationStatus,
  getTrackingHttpsStatus,
  reconcileMailgunTrackingHttps,
  resolveFinalTrackingReconciliation,
} from './emailDomainService.js';

function fakeClient(domainStates, updateError = null) {
  let index = 0;
  const updates = [];
  return {
    updates,
    domains: {
      get: async () => domainStates[Math.min(index++, domainStates.length - 1)],
      update: async (domain, data) => {
        updates.push({ domain, data });
        if (updateError) throw updateError;
        return domainStates[domainStates.length - 1];
      },
    },
  };
}

test('new or already HTTPS active domains are ready without an update', async () => {
  const client = fakeClient([{ web_scheme: 'https', state: 'active', sending_dns_records: [] }]);
  const result = await reconcileMailgunTrackingHttps('email.example.org', client);
  assert.equal(result.success, true);
  assert.equal(result.tracking_tls_ready, true);
  assert.equal(result.changed, false);
  assert.deepEqual(client.updates, []);
});

test('legacy HTTP domain is upgraded idempotently to HTTPS', async () => {
  const client = fakeClient([
    { web_scheme: 'http', state: 'active', sending_dns_records: [] },
    { web_scheme: 'https', state: 'active', sending_dns_records: [] },
  ]);
  const result = await reconcileMailgunTrackingHttps('email.example.org', client);
  assert.equal(result.success, true);
  assert.equal(result.changed, true);
  assert.equal(result.tracking_scheme, 'https');
  assert.deepEqual(client.updates, [{ domain: 'email.example.org', data: { web_scheme: 'https' } }]);
});

test('failed HTTPS upgrade reports DNS and certificate action', async () => {
  const domain = {
    web_scheme: 'http',
    state: 'unverified',
    sending_dns_records: [{ record_type: 'CNAME', name: 'email.example.org', value: 'mailgun.org', valid: false }],
  };
  const client = fakeClient([domain], new Error('certificate unavailable'));
  const result = await reconcileMailgunTrackingHttps('email.example.org', client);
  assert.equal(result.success, false);
  assert.equal(result.tracking_tls_ready, false);
  assert.match(result.tracking_tls_action, /DNS records/);
  assert.equal(result.tracking_tls_dns_records[0].name, 'email.example.org');
});

test('active HTTP domain never appears fully ready', () => {
  const status = getTrackingHttpsStatus({ web_scheme: 'http', state: 'active' });
  assert.equal(status.tracking_tls_ready, false);
  assert.equal(status.tracking_tls_status, 'pending');
});

test('authoritative final GET can promote a domain after an earlier pending verification response', () => {
  const earlierVerifyResponse = { web_scheme: 'https', state: 'unverified' };
  const finalDomainInfo = { web_scheme: 'https', state: 'active' };
  assert.equal(getEmailDomainVerificationStatus(earlierVerifyResponse), 'pending');
  assert.equal(getEmailDomainVerificationStatus(finalDomainInfo), 'verified');
});

test('authoritative active HTTPS final GET clears an earlier transient reconciliation failure', () => {
  const finalResult = resolveFinalTrackingReconciliation(
    { web_scheme: 'https', state: 'active' },
    { success: false, tracking_tls_error: 'temporary GET failure' },
  );
  assert.equal(finalResult.success, true);
  assert.equal(finalResult.tracking_tls_ready, true);
  assert.equal(finalResult.tracking_tls_status, 'ready');
});