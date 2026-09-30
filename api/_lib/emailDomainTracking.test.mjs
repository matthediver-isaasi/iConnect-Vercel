import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  getEmailDomainVerificationStatus,
  getTrackingHttpsStatus,
  reconcileMailgunTrackingHttps,
  resolveTrackingHostname,
  resolveFinalTrackingReconciliation,
  verifyTrackingTlsCertificate,
} from './emailDomainService.js';
import {
  mapWithConcurrency,
  reconcileSendingDomainStatus,
} from '../functions/backfill-mailgun-tracking-https.js';

const trackingRecord = {
  record_type: 'CNAME',
  name: 'email.example.org',
  value: 'eu.mailgun.org',
  valid: 'valid',
};
const tlsReady = async () => ({ ready: true, error: null });

function fakeTlsConnector(outcome, capture) {
  return (options, onSecureConnect) => {
    capture.options = options;
    const socket = new EventEmitter();
    socket.setTimeout = (timeout, callback) => {
      capture.timeout = timeout;
      capture.timeoutCallback = callback;
    };
    socket.destroy = () => {
      capture.destroyed = true;
    };
    queueMicrotask(() => {
      if (outcome.ready) {
        onSecureConnect();
      } else {
        const error = new Error(outcome.error);
        error.code = outcome.code;
        socket.emit('error', error);
      }
    });
    return socket;
  };
}

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
  const client = fakeClient([{ web_scheme: 'https', state: 'active', sending_dns_records: [trackingRecord] }]);
  const result = await reconcileMailgunTrackingHttps('email.example.org', client, tlsReady);
  assert.equal(result.success, true);
  assert.equal(result.tracking_tls_ready, true);
  assert.equal(result.changed, false);
  assert.deepEqual(client.updates, []);
});

test('legacy HTTP domain is upgraded idempotently to HTTPS', async () => {
  const client = fakeClient([
    { web_scheme: 'http', state: 'active', sending_dns_records: [trackingRecord] },
    { web_scheme: 'https', state: 'active', sending_dns_records: [trackingRecord] },
  ]);
  const result = await reconcileMailgunTrackingHttps('email.example.org', client, tlsReady);
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

test('active HTTPS domain with pending tracking DNS cannot become ready', async () => {
  const pendingRecord = { ...trackingRecord, valid: 'unknown' };
  const client = fakeClient([{ web_scheme: 'https', state: 'active', sending_dns_records: [pendingRecord] }]);
  const result = await reconcileMailgunTrackingHttps('mg.example.org', client, tlsReady);
  assert.equal(result.mailgun_domain_active, true);
  assert.equal(result.tracking_dns_valid, false);
  assert.equal(result.tracking_certificate_ready, true);
  assert.equal(result.tracking_tls_ready, false);
  assert.match(result.tracking_tls_action, /Correct the tracking DNS record/);
});

test('legacy boolean DNS validity remains compatible', async () => {
  const client = fakeClient([{
    web_scheme: 'https',
    state: 'active',
    sending_dns_records: [{ ...trackingRecord, valid: true }],
  }]);
  const result = await reconcileMailgunTrackingHttps('mg.example.org', client, tlsReady);
  assert.equal(result.tracking_dns_valid, true);
  assert.equal(result.tracking_tls_ready, true);
});

test('tracking hostname comes from the Mailgun tracking CNAME, not the sending domain', () => {
  const domain = {
    name: 'mg.example.org',
    sending_dns_records: [
      { record_type: 'TXT', name: 'mg.example.org', value: 'v=spf1 include:mailgun.org' },
      { record_type: 'CNAME', name: 'email.example.org', value: 'eu.mailgun.org' },
    ],
  };
  assert.equal(resolveTrackingHostname(domain), 'email.example.org');
});

test('unrelated or ambiguous CNAME records are never accepted as the tracking hostname', () => {
  assert.equal(resolveTrackingHostname({
    sending_dns_records: [{ record_type: 'CNAME', name: 'www.example.org', value: 'example.vercel-dns.com', valid: true }],
  }), null);
  assert.equal(resolveTrackingHostname({
    sending_dns_records: [
      trackingRecord,
      { ...trackingRecord, name: 'email2.example.org' },
    ],
  }), null);
});

test('active HTTPS domain is not ready when certificate is for the Mailgun origin', async () => {
  const client = fakeClient([{ web_scheme: 'https', state: 'active', sending_dns_records: [trackingRecord] }]);
  const result = await reconcileMailgunTrackingHttps('mg.example.org', client, async hostname => ({
    ready: false,
    code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    error: `Hostname/IP does not match certificate's altnames: Host: ${hostname}. is not in the cert's altnames: DNS:eu.mailgun.org`,
  }));
  assert.equal(result.success, false);
  assert.equal(result.tracking_hostname, 'email.example.org');
  assert.equal(result.tracking_dns_valid, true);
  assert.equal(result.tracking_certificate_ready, false);
  assert.equal(result.tracking_tls_ready, false);
  assert.equal(result.tracking_tls_status, 'error');
  assert.match(result.tracking_tls_action, /contact Mailgun support/);
});

test('active HTTPS domain becomes ready only with a valid custom-host certificate', async () => {
  const client = fakeClient([{ web_scheme: 'https', state: 'active', sending_dns_records: [trackingRecord] }]);
  const result = await reconcileMailgunTrackingHttps('mg.example.org', client, tlsReady);
  assert.equal(result.tracking_hostname, 'email.example.org');
  assert.equal(result.tracking_certificate_ready, true);
  assert.equal(result.tracking_tls_ready, true);
});

test('live TLS verifier requires trust and exact SNI hostname', async () => {
  const capture = {};
  const result = await verifyTrackingTlsCertificate(
    'email.example.org',
    3210,
    fakeTlsConnector({ ready: true }, capture),
  );
  assert.deepEqual(capture.options, {
    host: 'email.example.org',
    port: 443,
    servername: 'email.example.org',
    rejectUnauthorized: true,
  });
  assert.equal(capture.timeout, 3210);
  assert.equal(capture.destroyed, true);
  assert.deepEqual(result, { ready: true, error: null });
});

test('live TLS verifier preserves certificate hostname mismatch failures', async () => {
  const capture = {};
  const result = await verifyTrackingTlsCertificate(
    'email.example.org',
    8000,
    fakeTlsConnector({
      ready: false,
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      error: "Host is not in the certificate's altnames: DNS:eu.mailgun.org",
    }, capture),
  );
  assert.equal(result.ready, false);
  assert.equal(result.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.match(result.error, /eu\.mailgun\.org/);
});

test('authoritative final GET can promote a domain after an earlier pending verification response', () => {
  const earlierVerifyResponse = { web_scheme: 'https', state: 'unverified', sending_dns_records: [trackingRecord] };
  const finalDomainInfo = { web_scheme: 'https', state: 'active', sending_dns_records: [trackingRecord] };
  assert.equal(getEmailDomainVerificationStatus(earlierVerifyResponse), 'pending');
  assert.equal(getEmailDomainVerificationStatus(finalDomainInfo, { ready: true }), 'verified');
});

test('authoritative active HTTPS final GET clears an earlier transient reconciliation failure', () => {
  const finalResult = resolveFinalTrackingReconciliation(
    { web_scheme: 'https', state: 'active', sending_dns_records: [trackingRecord] },
    { success: false, tracking_tls_error: 'temporary GET failure' },
    { ready: true },
  );
  assert.equal(finalResult.success, true);
  assert.equal(finalResult.tracking_tls_ready, true);
  assert.equal(finalResult.tracking_tls_status, 'ready');
});

test('backfill preserves verified sending status when Mailgun activation is unknown', () => {
  assert.equal(reconcileSendingDomainStatus('verified', null), 'verified');
  assert.equal(reconcileSendingDomainStatus('error', undefined), 'error');
  assert.equal(reconcileSendingDomainStatus('pending', true), 'verified');
  assert.equal(reconcileSendingDomainStatus('verified', false), 'pending');
});

test('backfill bounds slow tracking checks with concurrency while preserving result order', async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async value => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return value * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
  assert.equal(maxActive, 2);
});