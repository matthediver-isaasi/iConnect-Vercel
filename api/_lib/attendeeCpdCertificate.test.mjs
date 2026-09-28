import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { resolveAttendeeCertificate, renderAttendeeCertificate, realCertificatePlaceholders } from './attendeeCpdCertificate.js';
import { handleAttendeeCertificate } from '../reports/attendee-cpd-certificate.js';
import { renderCpdEmailContent, prepareCpdEmail } from './eventCpdEmail.js';

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
        ilike(k, v) { filters.push(row => String(row[k] || '').toLowerCase() === v.toLowerCase()); return q; },
        order(k, opts = {}) { orders.push([k, opts.ascending !== false]); return q; },
        limit(n) { count = n; return q; },
        range(a, b) { offset = a; count = b - a + 1; return q; },
        update(value) {
          if (table === 'attendee_cpd_certificate_delivery') {
            const writable = new Set(['status', 'provider_message_id', 'error', 'updated_at', 'rendered_email']);
            assert.ok(Object.keys(value).every(key => writable.has(key)), 'delivery finalization must respect service_role column grants');
          }
          update = value; return q;
        },
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
    member: [], event_cpd_points_rule: [],
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

test('sample/default/literal data cannot leak; missing email permits preview; only matched attendee ledger values contribute member points', async () => {
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
  f.db.rows.member = [{ id: 'attendee-member', tenant_id: tenantId, email: '', first_name: 'Real' }];
  f.booking.attendee_email = 'attendee@example.test';
  f.db.rows.member[0].email = 'attendee@example.test';
  f.db.rows.member_cpd_points_ledger[0].member_id = 'attendee-member';
  f.db.rows.member_cpd_points_ledger[1].member_id = 'attendee-member';
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
    return { success: true, messageId: 'provider-1', renderedSubject: 'Final subject',
      renderedHtml: '<p>Final recipient footer</p>', renderedText: 'Final text', fromAddress: 'sender@example.test', domain: 'example.test' };
  };
  const results = await Promise.all([
    invoke(f, { ...input, recipient: 'attacker@example.test' }, { send }), invoke(f, input, { send }),
  ]);
  assert.equal(sends, 1);
  assert.equal(results.some(r => r.body.success), true);
  const delivery = f.db.rows.attendee_cpd_certificate_delivery[0];
  assert.equal(delivery.provenance.delivered_email, undefined);
  assert.deepEqual(delivery.rendered_email, {
    subject: 'Final subject', html: '<p>Final recipient footer</p>', text: 'Final text',
    from: 'sender@example.test', domain: 'example.test',
  });
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

function selectEmail(f) {
  const email = { id: '66666666-6666-4666-8666-666666666666', tenant_id: tenantId,
    name: 'Personal certificate', category: 'events', is_active: true,
    subject: '{{attendee_first_name}}: {{event_name}} ({{cpd_points}})',
    body: '<p>{{attendee_name}} {{activity_date_range}} {{cpd_points}} {{organisation_name}}</p>{{communication_preferences_link}}',
    from_name: 'Certificates', reply_to: 'help@example.test' };
  f.config.eventRule.email_template_id = email.id;
  f.db.rows.email_template = [email];
  return email;
}

test('CPD email rendering is single-pass, escapes guest data, blanks unknowns and missing values, retains zero and authored preference tokens', () => {
  const html = renderCpdEmailContent('{{attendee_name}} {{cpd_points}} {{unknown}} {{organisation_name}} {{communication_preferences_link}}',
    { attendee_name: '<a>{{communication_preferences_url}}</a>', cpd_points: 0 }, true);
  assert.match(html, /&lt;a&gt;&#123;&#123;communication_preferences_url/);
  assert.match(html, / 0 /);
  assert.equal(html.endsWith('{{communication_preferences_link}}'), true);
  assert.equal(html.includes('{{unknown}}'), false);
  assert.equal(renderCpdEmailContent('{{attendee_name}}', { attendee_name: '{{cpd_points}}' }), 'cpd_points');
});

test('simple and complex saved templates personalize matched attendees using ledger points, attach PDF and audit message; selection/content invalidate confirmation', async () => {
  for (const source of ['standard', 'complex']) {
    const f = await fixture(source); claims(f);
    const email = selectEmail(f);
    f.db.rows.member_cpd_points_ledger = [
      { id: '1', tenant_id: tenantId, booking_type: source === 'standard' ? 'booking' : 'complex_event_booking',
        booking_id: bookingId, event_id: eventId, event_type: source === 'standard' ? 'event' : 'complex_event', points_value: 4 },
      { id: '2', tenant_id: tenantId, booking_type: source === 'standard' ? 'booking' : 'complex_event_booking',
        booking_id: bookingId, event_id: eventId, event_type: source === 'standard' ? 'event' : 'complex_event', points_value: -1 },
    ];
    f.db.rows.member = [{ id: 'attendee-member', tenant_id: tenantId, email: f.booking.attendee_email }];
    f.db.rows.member_cpd_points_ledger.forEach(row => { row.member_id = 'attendee-member'; });
    const r = await resolveAttendeeCertificate(f.db, f.identity);
    assert.equal(r.email_template_name, email.name);
    assert.equal(r.email_is_default, false);
    assert.equal(r.email_message.subject, 'Real: Real event (3)');
    assert.match(r.email_message.html, /29 March 2026 – 30 March 2026 3/);
    assert.equal(r.provenance.email.rendered_message.subject, r.email_message.subject);
    const input = { booking_id: bookingId, booking_source: source, action: 'send',
      expected_fingerprint: r.fingerprint, confirmed: true, request_id: randomUUID() };
    let sends = 0;
    const send = async opts => {
      sends++;
      assert.equal(opts.subject, r.email_message.subject);
      assert.equal(opts.to, f.booking.attendee_email);
      assert.equal(opts.replyTo, 'help@example.test');
      assert.equal(opts.resolveTransactionalPreferences, true);
      assert.equal(opts.attachments[0].data.subarray(0, 5).toString(), '%PDF-');
      return { success: true };
    };
    assert.equal((await invoke(f, input, { send })).body.success, true);
    email.body += ' Updated';
    assert.equal((await invoke(f, { ...input, request_id: randomUUID(), deliberate_resend: true }, { send })).statusCode, 409);
    email.body = r.provenance.email.body;
    f.config.eventRule.email_template_id = null;
    assert.equal((await invoke(f, input, { send })).statusCode, 409);
    assert.equal(sends, 1);
  }
});

test('guest certificate uses ticket override instead of event points; preview and email attach the same PDF without a member award', async () => {
  for (const source of ['standard', 'complex']) {
    const f = await fixture(source); claims(f); selectEmail(f);
    f.booking.member_id = 'purchaser';
    f.db.rows.member = [{ id: 'purchaser', tenant_id: tenantId, email: 'purchaser@example.test',
      membership_number: 'PURCHASER' }];
    f.db.rows.cpd_certificate_placeholder.push(field('cpd.cpd_points', { missing_policy: 'error' }));
    f.db.rows.event_cpd_points_rule = [
      { id: 'wide', tenant_id: tenantId, event_type: source === 'standard' ? 'event' : 'complex_event',
        event_id: eventId, active: true, ticket_id: null, trigger_type: 'registration', points_value: '8' },
      { id: 'ticket-rule', tenant_id: tenantId, event_type: source === 'standard' ? 'event' : 'complex_event',
        event_id: eventId, active: true, ticket_id: 'ticket', trigger_type: 'registration', points_value: '5' },
    ];
    f.db.rows.member_cpd_points_ledger = [{ id: 'purchaser-award', tenant_id: tenantId,
      member_id: 'purchaser', booking_type: source === 'standard' ? 'booking' : 'complex_event_booking',
      booking_id: bookingId, event_type: source === 'standard' ? 'event' : 'complex_event',
      event_id: eventId, points_value: 8 }];
    let r = await resolveAttendeeCertificate(f.db, f.identity);
    assert.equal(r.values['cpd.cpd_points'], '5');
    assert.equal(r.values['member.membership_number'], '');
    assert.equal(r.email_message.subject, 'Real: Real event (5)');
    assert.equal(r.provenance.guest_certificate_points_evidence.rule_id, 'ticket-rule');
    assert.deepEqual(r.provenance.points_ledger, []);
    const input = { booking_id: bookingId, booking_source: source };
    const metadata = (await invoke(f, { ...input, method: 'GET' })).body;
    assert.equal(metadata.certificate_points, '5');
    assert.equal(metadata.certificate_points_source, 'guest_rule');
    const pdf = (await invoke(f, { ...input, action: 'preview', expected_fingerprint: metadata.fingerprint })).body;
    let sent = 0;
    const response = await invoke(f, { ...input, action: 'send', confirmed: true,
      expected_fingerprint: metadata.fingerprint, request_id: randomUUID() }, {
      send: async opts => {
        sent++;
        assert.equal(opts.to, 'attendee@example.test');
        assert.equal(opts.subject, 'Real: Real event (5)');
        assert.deepEqual(opts.attachments[0].data, pdf);
        return { success: true };
      },
    });
    assert.equal(response.body.success, true);
    assert.equal(sent, 1);
    assert.equal(f.db.rows.member_cpd_points_ledger.length, 1);
    assert.equal(f.db.rows.attendee_cpd_certificate_delivery[0].provenance.guest_certificate_points_evidence.qualifies, true);
    f.booking.ticket_class_id = null;
    f.booking.ticket_class_name = 'Ticket';
    r = await resolveAttendeeCertificate(f.db, f.identity);
    assert.equal(r.values['cpd.cpd_points'], '5');
    f.booking.ticket_class_id = 'ticket';
    f.db.rows.event_cpd_points_rule[1].active = false;
    assert.equal((await resolveAttendeeCertificate(f.db, f.identity)).values['cpd.cpd_points'], '8');
  }
});

test('guest disabled, zero and attendance-only overrides cannot inherit registration points or use stale attendance', async () => {
  for (const source of ['standard', 'complex']) {
    const f = await fixture(source);
    f.db.rows.cpd_certificate_placeholder.push(field('cpd.cpd_points', { missing_policy: 'error' }));
    f.db.rows.event_cpd_points_rule = [
      { id: 'wide', tenant_id: tenantId, event_type: source === 'standard' ? 'event' : 'complex_event',
        event_id: eventId, active: true, ticket_id: null, trigger_type: 'registration', points_value: '8' },
      { id: 'ticket-rule', tenant_id: tenantId, event_type: source === 'standard' ? 'event' : 'complex_event',
        event_id: eventId, active: true, ticket_id: 'ticket', trigger_type: 'attendance', points_value: '5' },
    ];
    let r = await resolveAttendeeCertificate(f.db, f.identity);
    assert.match(r.reason, /cpd.cpd_points/);
    if (source === 'standard') {
      f.booking.checked_in_at = '2026-03-29T12:00:00Z';
      f.booking.check_in_reversed_at = '2026-03-29T13:00:00Z';
      assert.match((await resolveAttendeeCertificate(f.db, f.identity)).reason, /cpd.cpd_points/);
      f.booking.checked_in_at = '2026-03-29T14:00:00Z';
    } else {
      f.db.rows.complex_event_session_checkin = [{ id: 'checkin', tenant_id: tenantId,
        complex_event_id: eventId, booking_id: bookingId, session_id: 'session',
        checked_in_at: '2026-03-29T14:00:00Z' }];
      assert.match((await resolveAttendeeCertificate(f.db, f.identity)).reason, /cpd.cpd_points/);
      f.db.rows.complex_event_session = [{ id: 'session', tenant_id: tenantId, complex_event_id: eventId }];
    }
    r = await resolveAttendeeCertificate(f.db, f.identity);
    assert.equal(r.values['cpd.cpd_points'], '5');
    f.db.rows.event_cpd_points_rule[1].is_no_award = true;
    assert.match((await resolveAttendeeCertificate(f.db, f.identity)).reason, /cpd.cpd_points/);
    f.db.rows.event_cpd_points_rule[1].is_no_award = false;
    f.db.rows.event_cpd_points_rule[1].points_value = '0';
    assert.match((await resolveAttendeeCertificate(f.db, f.identity)).reason, /cpd.cpd_points/);
  }
});

test('matched attendee with missing member award does not borrow guest rule or purchaser ledger', async () => {
  const f = await fixture();
  f.db.rows.cpd_certificate_placeholder.push(field('cpd.cpd_points', { missing_policy: 'error' }));
  f.db.rows.member = [{ id: 'attendee', tenant_id: tenantId, email: f.booking.attendee_email }];
  f.db.rows.event_cpd_points_rule = [{ id: 'wide', tenant_id: tenantId, event_type: 'event',
    event_id: eventId, active: true, ticket_id: null, trigger_type: 'registration', points_value: '8' }];
  f.db.rows.member_cpd_points_ledger = [{ id: 'other', tenant_id: tenantId, member_id: 'purchaser',
    booking_type: 'booking', booking_id: bookingId, event_type: 'event', event_id: eventId, points_value: 8 }];
  assert.match((await resolveAttendeeCertificate(f.db, identity)).reason, /cpd.cpd_points/);
  f.db.rows.member_cpd_points_ledger.push({ ...f.db.rows.member_cpd_points_ledger[0],
    id: 'attendee-award', member_id: 'attendee', points_value: 5 });
  assert.equal((await resolveAttendeeCertificate(f.db, identity)).values['cpd.cpd_points'], 5);
});

test('guest attendance points require current online outcome belonging to a tracked target in the event', async () => {
  const f = await fixture();
  f.db.rows.cpd_certificate_placeholder.push(field('cpd.cpd_points', { missing_policy: 'error' }));
  f.db.rows.event_cpd_points_rule = [{ id: 'attendance', tenant_id: tenantId, event_type: 'event',
    event_id: eventId, active: true, ticket_id: 'ticket', trigger_type: 'attendance', points_value: '5' }];
  f.db.rows.attendance_current_outcome = [{ tenant_id: tenantId, booking_type: 'booking',
    booking_id: bookingId, provider: 'zoom', status: 'attended',
    attendance_target_id: 'target', outcome_revision_id: 'revision' }];
  f.db.rows.attendance_target = [{ tenant_id: tenantId, id: 'target', event_id: 'other', tracking_enabled: true }];
  assert.match((await resolveAttendeeCertificate(f.db, identity)).reason, /cpd.cpd_points/);
  f.db.rows.attendance_target[0].event_id = eventId;
  f.db.rows.attendance_target[0].tracking_enabled = false;
  assert.match((await resolveAttendeeCertificate(f.db, identity)).reason, /cpd.cpd_points/);
  f.db.rows.attendance_target[0].tracking_enabled = true;
  const eligible = await resolveAttendeeCertificate(f.db, identity);
  assert.equal(eligible.values['cpd.cpd_points'], '5');
  assert.equal(eligible.provenance.guest_certificate_points_evidence.id, 'revision');
  f.db.rows.attendance_current_outcome[0].status = 'absent';
  const current = await resolveAttendeeCertificate(f.db, identity);
  assert.notEqual(current.fingerprint, eligible.fingerprint);
  assert.match(current.reason, /cpd.cpd_points/);
});

test('deleted, cross-tenant, inactive and wrong-category email templates block sending but preserve PDF preview', async () => {
  for (const mutate of [
    (f) => { f.db.rows.email_template = []; },
    (_f, email) => { email.tenant_id = otherTenant; },
    (_f, email) => { email.is_active = false; },
    (_f, email) => { email.category = 'welcome'; },
  ]) {
    const f = await fixture(); const email = selectEmail(f); mutate(f, email);
    const r = await resolveAttendeeCertificate(f.db, identity);
    assert.equal(r.available, true); assert.equal(r.can_send, false);
    assert.match(r.email_reason, /administrator/);
    assert.equal(r.email_is_default, false);
    const result = await invoke(f, { booking_id: bookingId, booking_source: 'standard', action: 'preview', expected_fingerprint: r.fingerprint });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.subarray(0, 5).toString(), '%PDF-');
  }
});

test('tenant sender constraints reject unsafe envelopes and recheck content changes immediately before provider', async () => {
  const f = await fixture(); const email = selectEmail(f); claims(f);
  email.from_email = 'impersonate@another-tenant.test';
  assert.equal((await resolveAttendeeCertificate(f.db, identity)).can_send, false);
  email.from_email = null;
  email.from_name = 'Bad\r\nBcc: victim@example.test';
  assert.match((await prepareCpdEmail(f.db, tenantId, { template: email }, {})).reason, /sender name/);
  email.from_name = 'Certificates';
  const r = await resolveAttendeeCertificate(f.db, identity);
  let calls = 0;
  const result = await invoke(f, { booking_id: bookingId, booking_source: 'standard', action: 'send',
    confirmed: true, request_id: randomUUID(), expected_fingerprint: r.fingerprint }, {
    render: async () => { email.subject += ' changed'; return Buffer.from('pdf'); },
    send: async () => { calls++; return { success: true }; },
  });
  assert.equal(calls, 0);
  assert.equal(result.body.latest_delivery.status, 'failed');
});