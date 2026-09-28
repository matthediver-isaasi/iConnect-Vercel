import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyCertificateConfig, validateCertificateConfig,
  resolveEventCpdCertificate,
} from './eventCpdCertificateRules.js';
import { certificateActivityDateValues } from '../../shared/eventCpdCertificateDates.js';
import { resolveEventCpdCertificatePolicy } from '../../shared/eventCpdCertificatePolicy.js';
import { handleCertificateRules } from '../admin/event-cpd-certificate-rules.js';

const template = '44444444-4444-4444-8444-444444444444';
const config = () => ({
  eventRule: { template_id: template, date_mode: 'custom', start_date: '2026-10-01', end_date: '2026-10-02' },
  ticketRules: {
    member: { template_mode: 'none', template_id: null, date_mode: 'inherit', start_date: null, end_date: null },
  },
});

test('backend rejects invalid dates, cross-event tickets and inactive/cross-tenant templates', () => {
  assert.equal(validateCertificateConfig(config(), ['member'], [template]).eventRule.template_id, template);
  assert.throws(() => validateCertificateConfig(config(), ['other'], [template]), /ticket/i);
  assert.throws(() => validateCertificateConfig(config(), ['member'], []), /active template/);
  assert.throws(() => validateCertificateConfig({ ...config(), eventRule: {
    ...config().eventRule, start_date: '2026-02-29',
  } }, ['member'], [template]), /date/i);
  assert.throws(() => validateCertificateConfig({ ...config(), ticketRules: { member: {
    template_mode: 'override', template_id: null, date_mode: 'inherit', start_date: null, end_date: null,
  } } }, ['member'], [template]), /template/i);
});

test('independent ticket template and date precedence preserves snapshot identity', () => {
  const value = resolveEventCpdCertificatePolicy({
    config: config(), event: {}, ticketReference: 'member', templates: [{ id: template, status: 'active', version: 3 }],
  });
  assert.equal(value.template_id, null);
  assert.equal(value.start_date, '2026-10-01');
  assert.equal(value.template_source, 'ticket');
  const inherited = resolveEventCpdCertificatePolicy({
    config: config(), event: {}, ticketReference: 'other', templates: [{ id: template, status: 'active', version: 3 }],
  });
  assert.equal(inherited.template.version, 3);
  assert.equal(certificateActivityDateValues(inherited)['cpd.activity_date'], '1 October 2026');
  assert.equal(certificateActivityDateValues(inherited)['cpd.activity_date_range'], '1 October 2026 – 2 October 2026');
  assert.equal(certificateActivityDateValues(inherited)['event.start_date'], undefined);
  assert.deepEqual(emptyCertificateConfig().ticketRules, {});
});

function mockDb({ saved = null, stored = null, event = { id: 'e', pricing_config: { ticket_classes: [{ id: 'member' }] } },
  templates = [{ id: template, status: 'active', name: 'Certificate', version: 2, source_sha256: 'sha', source_path: 'private.pdf' }] } = {}) {
  const calls = [];
  const db = {
    from(table) {
      const filters = [];
      const chain = {
        select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
        order() { return Promise.resolve({ data: templates, error: null }); },
        maybeSingle() {
          if (table === 'event' || table === 'complex_event') {
            return Promise.resolve({ data: event, error: null });
          }
          if (table === 'event_cpd_certificate_config') return Promise.resolve({ data: stored ? { config: stored } : null, error: null });
          if (table === 'cpd_certificate_template') {
            return Promise.resolve({ data: templates.find(t => t.id === filters.find(([key]) => key === 'id')?.[1]) || null, error: null });
          }
          throw new Error(`Unexpected table ${table}`);
        },
      };
      return chain;
    },
    async rpc(name, args) {
      calls.push([name, args]);
      return { data: saved || args.p_config, error: null };
    },
  };
  return { db, calls };
}
function response() {
  return { status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
}
const deps = db => ({
  db, contextFor: async () => ({ tenantId: 'tenant1', isAuthenticated: true }),
  adminAccess: async () => true,
});

test('GET safe template metadata and missing historical template indication', async () => {
  const stored = config(); stored.eventRule.template_id = '55555555-5555-4555-8555-555555555555';
  const { db } = mockDb({ stored });
  const res = response();
  await handleCertificateRules({ method: 'GET', query: { event_type: 'simple', event_id: 'e' } }, res, deps(db));
  assert.equal(res.code, 200);
  assert.equal(res.data.templates[1].unavailable, true);
  assert.equal(res.data.templates[1].name, 'Unavailable template');
  assert.equal(res.data.templates[0].source_path, undefined);
});

test('PUT writes through atomic RPC and rejects invalid or unauthorized changes', async () => {
  const { db, calls } = mockDb();
  const req = { method: 'PUT', body: { event_type: 'simple', event_id: 'e', config: config() } };
  const res = response();
  await handleCertificateRules(req, res, deps(db));
  assert.equal(res.code, 200);
  assert.equal(calls[0][0], 'replace_event_cpd_certificate_config');
  req.body.config.ticketRules.stolen = req.body.config.ticketRules.member;
  await handleCertificateRules(req, res, deps(db));
  assert.equal(res.code, 400);
  assert.equal(calls.length, 1);
  await handleCertificateRules(req, res, { ...deps(db), adminAccess: async () => false });
  assert.equal(res.code, 403);
  await handleCertificateRules({ method: 'GET', query: { event_type: 'simple' } }, res, {
    ...deps(db), contextFor: async () => null,
  });
  assert.equal(res.code, 401);
});

test('resolver supplies date-only placeholders in event timezone, no issuance', async () => {
  const { db } = mockDb({ stored: {
    eventRule: { template_id: template, date_mode: 'event', start_date: null, end_date: null },
    ticketRules: {},
  }, event: { id: 'e', start_date: '2026-03-29T00:30:00Z', end_date: '2026-03-29T22:30:00Z',
    timezone: 'Europe/London', pricing_config: { ticket_classes: [{ id: 'member' }] } } });
  const result = await resolveEventCpdCertificate(db, {
    tenantId: 'tenant1', eventType: 'simple', eventId: 'e', ticketId: 'member',
  });
  assert.equal(result.start_date, '2026-03-29');
  assert.equal(result.end_date, '2026-03-29');
  assert.equal(result.template_version, 2);
  assert.equal(result.available, true);
  assert.equal(result.placeholders['cpd.activity_date'], '29 March 2026');
  assert.equal(result.placeholders['cpd.activity_date_range'], '29 March 2026');
  assert.equal(result.placeholders['event.start_date'], undefined);
  assert.equal(result.provenance.tenant_id, 'tenant1');
  assert.equal(result.provenance.event_id, 'e');
  assert.equal(result.provenance.ticket_reference, 'member');
  assert.equal(result.provenance.dates, 'event');
});

test('active template with missing source cannot be rendered', async () => {
  const { db } = mockDb({ stored: {
    eventRule: { template_id: template, date_mode: 'custom', start_date: '2026-10-01', end_date: null },
    ticketRules: {},
  }, templates: [{ id: template, status: 'active', version: 2, source_path: null }],
  });
  const result = await resolveEventCpdCertificate(db, { tenantId: 'tenant1', eventType: 'simple', eventId: 'e', ticketId: 'member' });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'template_unavailable');
});