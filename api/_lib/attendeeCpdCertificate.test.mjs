import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { resolveAttendeeCertificate, renderAttendeeCertificate, realCertificatePlaceholders } from './attendeeCpdCertificate.js';
import { handleAttendeeCertificate } from '../reports/attendee-cpd-certificate.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenant = '22222222-2222-4222-8222-222222222222';
const bookingId = '33333333-3333-4333-8333-333333333333';
const eventId = '44444444-4444-4444-8444-444444444444';
const templateId = '55555555-5555-4555-8555-555555555555';
const identity = { tenantId, bookingId, bookingSource: 'standard' };
const field = (key, extra = {}) => ({
  id: randomUUID(), tenant_id: tenantId, template_id: templateId, placeholder_key: key,
  page_number: 1, display_order: 0, x: 20, y: 20, width: 350, height: 35,
  font_size: 12, missing_policy: 'blank', ...extra,
});

// Fluent REST mock applies every tenant and identity filter, and never reaches
// any real DB/email provider. SQL concurrency is covered by the migration test.
function database(rows) {
  return {
    rows,
    from(table) {
      const filters = [];
      let update, offset = 0, count = Infinity, single = false;
      const orders = [];
      const q = {
        select() { return q; }, eq(k, v) { filters.push(row => row[k] === v); return q; },
        order(k, opts = {}) { orders.push([k, opts.ascending !== false]); return q; },
        limit(n) { count = n; return q; },
        range(a, b) { offset = a; count = b - a + 1; return q; },
        update(value) { update = value; return q; },
        maybeSingle() { single = true; return q; }, single() { single = true; return q; },
        then(resolve, reject) {
          try {
            let data = (rows[table] || []).filter(row => filters.every(f => f(row)));
            if (update) data.forEach(row => Object.assign(row, update));
            data = data.slice().sort((a, b) => {
              for (const [key, asc] of orders) {
                if (a[key] !== b[key]) return (a[key] > b[key] ? 1 : -1) * (asc ? 1 : -1);
              }
              return 0;
            }).slice(offset, offset + count).map(row => ({ ...row }));
            return Promise.resolve({ data: single ? data[0] || null : data, error: null }).then(resolve, reject);
          } catch (error) { return Promise.reject(error).then(resolve, reject); }
        },
      };
      return q;
    },
  };
}

async function fixture(source = 'standard') {
  const document = await PDFDocument.create(); document.addPage([500, 300]);
  const bytes = Buffer.from(await document.save());
  const booking = { id: bookingId, tenant_id: tenantId, event_id: eventId, status: 'confirmed',
    ticket_class_id: 'ticket', attendee_first_name: 'Real', attendee_last_name: 'Attendee',
    attendee_email: 'attendee@example.test' };
  const event = { id: eventId, tenant_id: tenantId, title: 'Real event',
    start_date: '2026-03-29', end_date: '2026-03-30', timezone: 'Europe/London',
    pricing_config: { ticket_classes: [{ id: 'ticket', name: 'Ticket' }] } };
  const template = { id: templateId, tenant_id: tenantId, status: 'active', version: 1, name: 'Certificate',
    source_bucket: 'private-uploads', source_path: `${tenantId}/cpd-certificate-templates/source.pdf`,
    source_sha256: createHash('sha256').update(bytes).digest('hex') };
  const config = { eventRule: { template_id: templateId, date_mode: 'event', start_date: null, end_date: null }, ticketRules: {} };
  const db = database({
    [source === 'standard' ? 'booking' : 'complex_event_booking']: [booking],
    [source === 'standard' ? 'event' : 'complex_event']: [event],
    complex_event_ticket_class: [{ id: 'ticket', tenant_id: tenantId, complex_event_id: eventId, name: 'Ticket' }],
    event_cpd_certificate_config: [{ tenant_id: tenantId, event_id: eventId, event_type: source === 'standard' ? 'event' : 'complex_event', config }],
    cpd_certificate_template: [template], cpd_certificate_placeholder: [field('member.full_name')],
    attendee_cpd_certificate_delivery: [],
  });
  db.storage = { from(bucket) {
    assert.equal(bucket, 'private-uploads');
    return { async download(path) { assert.equal(path, template.source_path); return { data: new Blob([bytes]) }; } };
  } };
  return { db, booking, event, template, config, bytes, identity: { ...identity, bookingSource: source } };
}

test('regular and complex guests resolve real data without attendance or points awards, and render actual PDFs', async () => {
  for (const source of ['standard', 'complex']) {
    const f = await fixture(source);
    const resolved = await resolveAttendeeCertificate(f.db, f.identity);
    assert.equal(resolved.available, true);
    assert.equal(resolved.can_send, true);
    assert.equal(resolved.values['member.full_name'], 'Real Attendee');
    assert.equal(resolved.values['cpd.activity_date_range'], '29 March 2026 – 30 March 2026');
    assert.equal(resolved.values['cpd.cpd_points'], undefined);
    const pdf = await renderAttendeeCertificate(f.db, resolved);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
  }
});

test('suppression, ticket template override, independent dates, inactive/missing/private ownership and cancellation fail closed', async () => {
  const f = await fixture();
  f.config.ticketRules.ticket = { template_mode: 'none', date_mode: 'inherit' };
  assert.match((await resolveAttendeeCertificate(f.db, identity)).reason, /no template/);
  const override = { ...f.template, id: randomUUID(), name: 'Override' };
  f.db.rows.cpd_certificate_template.push(override);
  f.config.ticketRules.ticket = { template_mode: 'override', template_id: override.id,
    date_mode: 'custom', start_date: '2026-08-03', end_date: '2026-08-04' };
  let r = await resolveAttendeeCertificate(f.db, identity);
  assert.equal(r.template.id, override.id);
  assert.equal(r.values['cpd.activity_date_range'], '3 August 2026 – 4 August 2026');
  override.status = 'archived';
  assert.match((await resolveAttendeeCertificate(f.db, identity)).reason, /inactive/);
  override.status = 'active'; override.tenant_id = otherTenant;
  assert.match((await resolveAttendeeCertificate(f.db, identity)).reason, /unavailable/);
  override.tenant_id = tenantId; override.source_path = `${otherTenant}/source.pdf`;
  assert.equal((await resolveAttendeeCertificate(f.db, identity)).available, false);
  f.booking.status = 'cancelled';
  assert.match((await resolveAttendeeCertificate(f.db, identity)).reason, /cancelled/);
});

test('invalid date, missing name, ambiguous legacy ticket and unknown required fields explain unavailability', async () => {
  const f = await fixture();
  f.event.start_date = null;
  assert.match((await resolveAttendeeCertificate(f.db, identity)).reason, /date unavailable/);
  f.event.start_date = '2026-03-29'; f.booking.ticket_class_id = null;
  assert.match((await resolveAttendeeCertificate(f.db, identity)).reason, /unambiguously/);
  f.booking.ticket_class_name = 'Ticket';
  assert.equal((await resolveAttendeeCertificate(f.db, identity)).available, true);
  f.db.rows.cpd_certificate_placeholder.push(field('cpd.certificate_number', { missing_policy: 'error', default_value: 'FAKE', sample_value: 'SAMPLE' }));
  assert.match((await resolveAttendeeCertificate(f.db, identity)).reason, /cpd.certificate_number/);
  f.db.rows.cpd_certificate_placeholder = [];
  f.booking.attendee_first_name = ''; f.booking.attendee_last_name = '';
  assert.match((await resolveAttendeeCertificate(f.db, identity)).reason, /name is missing/);
});

test('sample/default/literal data cannot leak; missing email permits preview; only tenant booking ledger values contribute points', async () => {
  assert.deepEqual(realCertificatePlaceholders([field('x', { sample_value: 'SAMPLE', default_value: 'FAKE', missing_policy: 'literal' })], {}).placeholders[0].default_value, null);
  const f = await fixture();
  f.booking.attendee_email = '';
  f.db.rows.cpd_certificate_placeholder.push(field('cpd.cpd_points', { default_value: '800' }));
  let r = await resolveAttendeeCertificate(f.db, identity);
  assert.equal(r.available, true); assert.equal(r.can_send, false);
  assert.equal(r.values['cpd.cpd_points'], undefined);
  f.db.rows.member_cpd_points_ledger = [
    { id: '1', tenant_id: tenantId, booking_type: 'booking', booking_id: bookingId, event_type: 'event', event_id: eventId, points_value: '8' },
    { id: '2', tenant_id: tenantId, booking_type: 'booking', booking_id: bookingId, event_type: 'event', event_id: eventId, points_value: '-2' },
    { id: '3', tenant_id: otherTenant, booking_type: 'booking', booking_id: bookingId, event_type: 'event', event_id: eventId, points_value: '999' },
  ];
  r = await resolveAttendeeCertificate(f.db, identity);
  assert.equal(r.values['cpd.cpd_points'], 6);
  await assert.rejects(resolveAttendeeCertificate(f.db, { ...identity, tenantId: otherTenant }), /not found/);
  r.template.source_sha256 = 'bad';
  await assert.rejects(renderAttendeeCertificate(f.db, r), /source changed/);
});

async function invoke(f, input = {}, extra = {}) {
  const output = { statusCode: 200, headers: {} };
  const res = { setHeader(k, v) { output.headers[k] = v; },
    status(s) { output.statusCode = s; return res; },
    json(data) { output.body = data; return res; }, send(data) { output.body = data; return res; } };
  const { method = 'POST', ...body } = input;
  await handleAttendeeCertificate({ method, body, query: body }, res, {
    db: f.db, contextFor: async () => ({ tenantId, isAuthenticated: true, roleId: 'report-role', memberId: 'admin' }),
    adminAccess: async () => true, featureAccess: async () => true, ...extra,
  });
  return output;
}

test('report permissions, method validation, stale preview fingerprint and private PDF response', async () => {
  const f = await fixture();
  const input = { booking_id: bookingId, booking_source: 'standard' };
  assert.equal((await invoke(f, input, { contextFor: async () => null })).statusCode, 401);
  assert.equal((await invoke(f, input, { contextFor: async () => ({ tenantId, isAuthenticated: true, tenantMismatch: true }) })).statusCode, 409);
  assert.equal((await invoke(f, input, { adminAccess: async () => false })).statusCode, 403);
  assert.equal((await invoke(f, input, { featureAccess: async () => false })).statusCode, 403);
  assert.equal((await invoke(f, { ...input, method: 'DELETE' })).statusCode, 405);
  const meta = await invoke(f, { ...input, method: 'GET' });
  assert.equal(meta.body.template, undefined); assert.equal(meta.body.values, undefined);
  assert.equal(meta.body.available, true);
  const preview = { ...input, action: 'preview', expected_fingerprint: meta.body.fingerprint };
  assert.equal((await invoke(f, { ...preview, expected_fingerprint: 'stale' })).statusCode, 409);
  const pdf = await invoke(f, preview);
  assert.equal(pdf.headers['Content-Type'], 'application/pdf');
  assert.equal(pdf.headers['Cache-Control'], 'private, no-store');
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  f.booking.attendee_email = 'changed@example.test';
  assert.equal((await invoke(f, preview)).statusCode, 409);
});

function claims(f) {
  f.db.rpc = async (name, p) => {
    assert.equal(name, 'claim_attendee_cpd_certificate_delivery');
    const rows = f.db.rows.attendee_cpd_certificate_delivery;
    const retry = rows.find(row => row.request_id === p.p_request_id);
    if (retry) return { data: { claimed: false, reason: 'retry', delivery: retry } };
    const unresolved = rows.find(row => ['pending', 'unknown'].includes(row.status));
    if (unresolved) return { data: { claimed: false, reason: 'unresolved', delivery: unresolved } };
    const accepted = rows.find(row => row.status === 'accepted');
    if (accepted && !p.p_deliberate_resend) return { data: { claimed: false, reason: 'resend_required', delivery: accepted } };
    const row = { id: randomUUID(), request_id: p.p_request_id, status: 'pending', tenant_id: tenantId,
      booking_source: p.p_booking_source, booking_id: p.p_booking_id, recipient: p.p_recipient,
      created_at: new Date().toISOString(), provenance: p.p_provenance, actor: p.p_actor };
    rows.push(row);
    return { data: { claimed: true, delivery: row } };
  };
}
async function sendInput(f) {
  const r = await resolveAttendeeCertificate(f.db, identity);
  return { booking_id: bookingId, booking_source: 'standard', action: 'send',
    expected_fingerprint: r.fingerprint, confirmed: true, request_id: randomUUID() };
}

test('send uses server recipient, real PDF, tenant transport; duplicate/concurrent requests never replay; deliberate resend allowed', async () => {
  const f = await fixture(); claims(f);
  const input = await sendInput(f);
  let sends = 0;
  const send = async opts => {
    sends++;
    assert.equal(opts.to, 'attendee@example.test'); assert.equal(opts.tenantId, tenantId);
    assert.equal(opts.attachments[0].contentType, 'application/pdf');
    assert.equal((await PDFDocument.load(opts.attachments[0].data)).getPageCount(), 1);
    return { success: true, messageId: 'provider-1' };
  };
  const results = await Promise.all([
    invoke(f, { ...input, recipient: 'attacker@example.test' }, { send }), invoke(f, input, { send }),
  ]);
  assert.equal(sends, 1);
  assert.equal(results.some(r => r.body.success), true);
  const retry = await invoke(f, input, { send });
  assert.equal(retry.body.duplicate, true); assert.equal(retry.body.latest_delivery.status, 'accepted');
  assert.equal((await invoke(f, { ...input, request_id: randomUUID() }, { send })).statusCode, 409);
  const resent = await invoke(f, { ...input, request_id: randomUUID(), deliberate_resend: true }, { send });
  assert.equal(resent.body.success, true); assert.equal(sends, 2);
});

test('confirmation required; ambiguous/throwing provider fenced; definitive rejection recorded; pre-provider data change prevents send', async () => {
  for (const provider of [
    async () => ({ success: false, status: 400, ambiguousEffect: true, error: 'timeout' }),
    async () => { throw new Error('socket lost'); },
    async () => ({ success: false, status: 503, error: 'provider unavailable' }),
    async () => ({ success: false, status: 400, error: 'rejected' }),
  ]) {
    const f = await fixture(); claims(f);
    const input = await sendInput(f);
    assert.equal((await invoke(f, { ...input, confirmed: false }, { send: provider })).statusCode, 400);
    const result = await invoke(f, input, { send: provider });
    assert.equal(result.statusCode, 502);
    const status = result.body.latest_delivery.status;
    assert.equal(['unknown', 'failed'].includes(status), true);
    if (status === 'unknown') {
      let called = false;
      assert.equal((await invoke(f, { ...input, request_id: randomUUID(), deliberate_resend: true },
        { send: async () => { called = true; } })).statusCode, 409);
      assert.equal(called, false);
    }
  }
  const f = await fixture(); claims(f);
  const input = await sendInput(f);
  let calls = 0;
  const result = await invoke(f, input, {
    render: async () => { f.booking.attendee_email = 'new@example.test'; return Buffer.from('pdf'); },
    send: async () => { calls++; },
  });
  assert.equal(calls, 0); assert.equal(result.body.latest_delivery.status, 'failed');
});

test('missing recipient prevents transport, preparation failure records failed and audit-write failure keeps permanent pending fence', async () => {
  const f = await fixture(); claims(f);
  f.booking.attendee_email = 'invalid@example';
  let sends = 0;
  const send = async () => { sends++; return { success: true }; };
  assert.equal((await invoke(f, await sendInput(f), { send })).statusCode, 409);
  assert.equal(sends, 0);
  f.booking.attendee_email = 'real@example.test';
  const preparation = await invoke(f, await sendInput(f), {
    send, render: async () => { throw new Error('Source could not be read'); },
  });
  assert.equal(preparation.body.latest_delivery.status, 'failed');
  assert.equal(sends, 0);
  const realFrom = f.db.from;
  f.db.from = table => {
    const q = realFrom(table);
    if (table === 'attendee_cpd_certificate_delivery') {
      q.update = () => {
        q.then = (resolve, reject) => Promise.resolve({ error: new Error('DB connection lost') }).then(resolve, reject);
        return q;
      };
    }
    return q;
  };
  const input = await sendInput(f);
  const lost = await invoke(f, input, { send });
  assert.equal(lost.statusCode, 503); assert.match(lost.body.error, /Do not resend/);
  assert.equal(sends, 1);
  assert.equal(f.db.rows.attendee_cpd_certificate_delivery.some(row => row.status === 'pending'), true);
  const retry = await invoke(f, { ...input, request_id: randomUUID(), deliberate_resend: true }, { send });
  assert.equal(retry.statusCode, 409); assert.equal(sends, 1);
});