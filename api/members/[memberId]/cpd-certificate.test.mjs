import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME = '1';
const { __setRoleAccessOverlayForTests } = await import('../../_lib/roleVisibility.js');
__setRoleAccessOverlayForTests([]);
const { createMemberCpdCertificateHandler } = await import('./cpd-certificate.js');

const tenant = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const awardId = '33333333-3333-4333-8333-333333333333';
const bookingId = '44444444-4444-4444-8444-444444444444';
const eventId = '55555555-5555-4555-8555-555555555555';
const templateId = '66666666-6666-4666-8666-666666666666';
const member = { id: memberId, tenant_id: tenant, role_id: 'role', member_excluded_features: [] };

async function fixture(source = 'booking') {
  const doc = await PDFDocument.create(); doc.addPage([500, 300]);
  const bytes = Buffer.from(await doc.save());
  const db = { rows: {
    member_cpd_points_ledger: [{ id: awardId, tenant_id: tenant, member_id: memberId, entry_kind: 'event_award',
      points_value: 5, booking_id: bookingId, booking_type: source,
      event_type: source === 'booking' ? 'event' : 'complex_event', event_id: eventId }],
    [source]: [{ id: bookingId, tenant_id: tenant, event_id: eventId, status: 'confirmed',
      attendee_email: 'attendee@example.test', attendee_first_name: 'Real',
      attendee_last_name: 'Attendee', ticket_class_id: 'ticket', member_id: 'purchaser' }],
    [source === 'booking' ? 'event' : 'complex_event']: [{ id: eventId, tenant_id: tenant,
      title: 'Conference', start_date: '2026-03-29', end_date: '2026-03-30',
      pricing_config: { ticket_classes: [{ id: 'ticket', name: 'Ticket' }] } }],
    member: [{ id: memberId, tenant_id: tenant, email: 'attendee@example.test' },
      { id: 'purchaser', tenant_id: tenant, email: 'purchaser@example.test' }],
    complex_event_ticket_class: [{ id: 'ticket', tenant_id: tenant, complex_event_id: eventId }],
    event_cpd_certificate_config: [{ tenant_id: tenant, event_id: eventId,
      event_type: source === 'booking' ? 'event' : 'complex_event',
      config: { eventRule: { template_id: templateId, date_mode: 'event', start_date: null, end_date: null },
        ticketRules: {} } }],
    cpd_certificate_template: [{ id: templateId, tenant_id: tenant, name: 'Conference certificate',
      status: 'active', source_bucket: 'private-uploads', source_path: `${tenant}/source.pdf`,
      source_sha256: createHash('sha256').update(bytes).digest('hex') }],
    cpd_certificate_placeholder: [{ id: 'placeholder', tenant_id: tenant, template_id: templateId,
      placeholder_key: 'cpd.cpd_points', page_number: 1, display_order: 0, x: 20,
      y: 20, width: 100, height: 30, font_size: 12, missing_policy: 'error' }],
  } };
  const queried = [];
  db.from = table => {
    queried.push(table);
    assert.notEqual(table, 'email_template', 'member download must not prepare email');
    assert.notEqual(table, 'certificate_survey_entitlement', 'member download must not create survey grants');
    const conditions = [];
    let offset = 0; let count = Infinity; let ordering = null;
    const q = {
      select() { return q; },
      eq(key, value) { conditions.push(row => String(row[key]) === String(value)); return q; },
      ilike(key, value) { conditions.push(row => row[key]?.toLowerCase() === value.toLowerCase()); return q; },
      order(key) { ordering = key; return q; },
      limit(n) { count = n; return q; },
      range(a, b) { offset = a; count = b - a + 1; return q; },
      maybeSingle() { return Promise.resolve({ data: result()[0] || null, error: null }); },
      then(resolve, reject) { return Promise.resolve({ data: result(), error: null }).then(resolve, reject); },
    };
    function result() {
      let rows = (db.rows[table] || []).filter(row => conditions.every(condition => condition(row)));
      if (ordering) rows = rows.slice().sort((a, b) => String(a[ordering]).localeCompare(String(b[ordering])));
      return rows.slice(offset, offset + count).map(row => ({ ...row }));
    }
    return q;
  };
  db.storage = { from(bucket) {
    assert.equal(bucket, 'private-uploads');
    return { async download(path) { assert.equal(path, `${tenant}/source.pdf`); return { data: new Blob([bytes]) }; } };
  } };
  return { db, queried };
}

async function request(f, query = { ledger_entry_id: awardId, format: 'pdf' }, overrides = {}) {
  const output = { statusCode: 200, headers: {} };
  const res = {
    setHeader(k, v) { output.headers[k] = v; },
    status(code) { output.statusCode = code; return res; },
    json(body) { output.body = body; return res; },
    send(body) { output.body = body; return res; },
  };
  const handler = createMemberCpdCertificateHandler({
    db: f.db, getSessionMember: async () => member,
    getTenantContext: async () => null,
    resolveMemberExclusions: async () => [], ...overrides,
  });
  await handler({ method: 'GET', query: { memberId,
    ...(Object.hasOwn(query, 'ledger_entry_ids') ? {} : { ledger_entry_id: awardId, format: 'pdf' }),
    ...query } }, res);
  return output;
}

test('both event types render actual ledger-backed PDFs, without email or survey access', async () => {
  for (const source of ['booking', 'complex_event_booking']) {
    const f = await fixture(source);
    const result = await request(f);
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(result.headers['Cache-Control'], 'private, no-store');
    assert.equal(result.headers['Content-Type'], 'application/pdf');
    assert.match(result.headers['Content-Disposition'], new RegExp(awardId));
    assert.equal((await PDFDocument.load(result.body)).getPageCount(), 1);
    assert.equal(f.queried.includes('event_cpd_points_rule'), false);
  }
});

test('independent tenant administration serves metadata and actual PDF for either event type', async () => {
  for (const source of ['booking', 'complex_event_booking']) {
    const f = await fixture(source);
    const inputs = [];
    const options = {
      getSessionMember: async () => null,
      resolveMemberExclusions: async () => assert.fail('admin must not require self-service access'),
      getTenantContext: async () => ({ tenantId: tenant, isAuthenticated: true, tenantUserId: 'admin' }),
      hasAdminAccess: async context => {
        assert.equal(context.tenantId, tenant);
        return true;
      },
      resolveAttendeeCertificate: async (db, input) => {
        inputs.push(input);
        const { resolveAttendeeCertificate } = await import('../../_lib/attendeeCpdCertificate.js');
        return resolveAttendeeCertificate(db, input);
      },
    };
    const metadata = await request(f, { ledger_entry_ids: awardId }, {
      ...options, renderAttendeeCertificate: async () => assert.fail('metadata must not render'),
    });
    assert.equal(metadata.statusCode, 200, JSON.stringify(metadata.body));
    assert.equal(metadata.body.certificates[awardId].available, true);
    const download = await request(f, {}, options);
    assert.equal(download.statusCode, 200, JSON.stringify(download.body));
    assert.equal(download.headers['Content-Type'], 'application/pdf');
    assert.equal((await PDFDocument.load(download.body)).getPageCount(), 1);
    assert.deepEqual(inputs, Array(3).fill(null).map(() => ({
      tenantId: tenant, bookingId, bookingSource: source === 'booking' ? 'standard' : 'complex',
      memberCertificateId: memberId,
    })));
    assert.equal(f.queried.includes('email_template'), false);
    assert.equal(f.queried.includes('certificate_survey_entitlement'), false);
  }
});

test('admin selects the path member, never the admin identity, for attendee and ticket overrides', async () => {
  for (const source of ['booking', 'complex_event_booking']) {
    const f = await fixture(source);
    const options = {
      getSessionMember: async () => ({ ...member, id: 'admin', role_id: null }),
      getTenantContext: async () => ({ tenantId: tenant, isAuthenticated: true, tenantUserId: 'admin' }),
      hasAdminAccess: async () => true,
      resolveMemberExclusions: async () => assert.fail('admin role must not be required'),
    };
    const booking = f.db.rows[source][0];
    booking.member_id = 'admin';
    // The purchaser does not replace the attendee even on the admin path.
    assert.equal((await request(f, { ledger_entry_ids: awardId }, options)).body.certificates[awardId].available, true);
    f.db.rows.event_cpd_certificate_config[0].config.ticketRules.ticket = {
      template_mode: 'none', date_mode: 'inherit',
    };
    assert.equal((await request(f, { ledger_entry_ids: awardId }, options)).body.certificates[awardId].available, false);
    assert.equal((await request(f, {}, options)).statusCode, 409);
    f.db.rows.event_cpd_certificate_config[0].config.ticketRules = {};
    booking.attendee_email = 'purchaser@example.test';
    assert.equal((await request(f, { ledger_entry_ids: awardId }, options)).body.certificates[awardId].available, false);
    assert.equal((await request(f, {}, options)).statusCode, 404);
  }
});

test('admin fails closed for cross-tenant and forged IDs, ordinary callers and mismatched contexts', async () => {
  const f = await fixture();
  const admin = {
    getSessionMember: async () => null,
    getTenantContext: async () => ({ tenantId: tenant, isAuthenticated: true, tenantUserId: 'admin' }),
    hasAdminAccess: async () => true,
  };
  const foreign = '88888888-8888-4888-8888-888888888888';
  for (const query of [
    { memberId: foreign },
    { ledger_entry_id: foreign },
    { memberId: foreign, ledger_entry_ids: awardId },
    { ledger_entry_ids: foreign },
  ]) {
    const result = await request(f, query, admin);
    if (query.ledger_entry_ids) assert.equal(result.body.certificates[query.ledger_entry_ids].available, false);
    else assert.equal(result.statusCode, 404);
  }
  for (const options of [
    { ...admin, getTenantContext: async () => ({ tenantId: foreign, isAuthenticated: true, tenantUserId: 'admin' }) },
    { ...admin, getTenantContext: async () => ({ tenantId: tenant, tenantMismatch: true }), hasAdminAccess: async () => true },
    { ...admin, getTenantContext: async () => null },
    { ...admin, hasAdminAccess: async () => false },
    { ...admin, hasAdminAccess: async () => { throw new Error('admin unavailable'); } },
    { getSessionMember: async () => ({ ...member, id: foreign }), getTenantContext: async () => ({
      tenantId: tenant, isAuthenticated: true, memberId: foreign,
    }), hasAdminAccess: async () => false },
  ]) {
    const result = await request(f, {}, options);
    assert.notEqual(result.statusCode, 200);
    assert.notEqual(result.headers['Content-Type'], 'application/pdf');
  }
  f.db.rows.member_cpd_points_ledger[0].tenant_id = foreign;
  const result = await request(f, { ledger_entry_ids: awardId }, admin);
  assert.equal(result.body.certificates[awardId].available, false);
  assert.equal((await request(f, {}, admin)).statusCode, 404);
});

test('admin fallback survives a dangling self role but uses the authorized context tenant', async () => {
  const f = await fixture();
  const result = await request(f, {}, {
    getSessionMember: async () => ({ ...member, tenant_id: 'untrusted-tenant' }),
    resolveMemberExclusions: async () => { throw new Error('dangling role'); },
    getTenantContext: async () => ({ tenantId: tenant, isAuthenticated: true, tenantUserId: 'admin' }),
    hasAdminAccess: async () => true,
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal((await PDFDocument.load(result.body)).getPageCount(), 1);
});

test('batch metadata is bounded and does not render PDFs or expose private paths', async () => {
  const f = await fixture();
  const missing = '77777777-7777-4777-8777-777777777777';
  const meta = await request(f, { ledger_entry_ids: `${awardId},${missing}` }, {
    renderAttendeeCertificate: async () => assert.fail('batch must not render PDF'),
  });
  assert.equal(meta.statusCode, 200, JSON.stringify(meta.body));
  assert.equal(meta.body.certificates[awardId].available, true);
  assert.equal(meta.body.certificates[missing].available, false);
  assert.equal(JSON.stringify(meta.body).includes('source.pdf'), false);
  for (const ids of ['', 'bad', `${awardId},${awardId}`, Array(21).fill(awardId).join(',')]) {
    assert.equal((await request(f, { ledger_entry_ids: ids })).statusCode, 400);
  }
});

test('member-only feature check rejects anonymous, wrong member, excluded feature and dangling role', async () => {
  const f = await fixture();
  for (const options of [
    { getSessionMember: async () => null },
    { getSessionMember: async () => ({ ...member, id: 'other' }) },
    { getSessionMember: async () => ({ ...member, role_id: null }) },
    { resolveMemberExclusions: async () => ['cpd.member_cpd'] },
    { resolveMemberExclusions: async () => ['cpd'] },
    { resolveMemberExclusions: async () => { throw new Error('dangling role'); } },
  ]) {
    const result = await request(f, {}, options);
    assert.notEqual(result.statusCode, 200);
    assert.notEqual(result.headers['Content-Type'], 'application/pdf');
  }
  assert.equal(f.queried.includes('member_cpd_points_ledger'), false);
});

test('denies foreign tenant/member, reversed, zero, imported and inconsistent booking or purchaser identity', async () => {
  const f = await fixture();
  const award = f.db.rows.member_cpd_points_ledger[0];
  for (const [key, value] of [
    ['tenant_id', 'other'], ['member_id', 'other'], ['entry_kind', 'imported_award'],
    ['entry_kind', 'reversal'], ['points_value', 0], ['event_id', 'other'],
    ['booking_type', 'wrong'],
  ]) {
    const saved = award[key]; award[key] = value;
    assert.equal((await request(f)).statusCode, 404, key);
    award[key] = saved;
  }
  f.db.rows.member_cpd_points_ledger.push({ id: 'reversal', tenant_id: tenant, member_id: memberId, reversal_of: awardId });
  assert.equal((await request(f)).statusCode, 404);
  f.db.rows.member_cpd_points_ledger.pop();
  f.db.rows.booking[0].attendee_email = 'purchaser@example.test';
  assert.equal((await request(f)).statusCode, 404);
});

test('missing/suppressed config, failed render and post-render reversal fail closed', async () => {
  const f = await fixture();
  f.db.rows.event_cpd_certificate_config[0].config.ticketRules.ticket = { template_mode: 'none', date_mode: 'inherit' };
  assert.equal((await request(f)).statusCode, 409);
  f.db.rows.event_cpd_certificate_config[0].config.ticketRules = {};
  const failed = await request(f, {}, { renderAttendeeCertificate: async () => { throw new Error('private source path'); } });
  assert.equal(failed.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(failed.body), /private source path/);
  const changed = await request(f, {}, { renderAttendeeCertificate: async () => {
    f.db.rows.member_cpd_points_ledger.push({
      id: 'reversal', tenant_id: tenant, member_id: memberId, reversal_of: awardId,
    });
    return Buffer.from('fake pdf');
  } });
  assert.equal(changed.statusCode, 409);
  assert.notEqual(changed.headers['Content-Type'], 'application/pdf');
});

test('admin metadata and PDF reject reversal, deleted event, render failure and post-render changes', async () => {
  for (const source of ['booking', 'complex_event_booking']) {
    const f = await fixture(source);
    const options = {
      getSessionMember: async () => null,
      getTenantContext: async () => ({ tenantId: tenant, isAuthenticated: true, tenantUserId: 'admin' }),
      hasAdminAccess: async () => true,
    };
    const reversal = { id: 'reversal', tenant_id: tenant, member_id: memberId, reversal_of: awardId };
    f.db.rows.member_cpd_points_ledger.push(reversal);
    assert.equal((await request(f, { ledger_entry_ids: awardId }, options)).body.certificates[awardId].available, false);
    assert.equal((await request(f, {}, options)).statusCode, 404);
    f.db.rows.member_cpd_points_ledger.pop();
    const event = f.db.rows[source === 'booking' ? 'event' : 'complex_event'].pop();
    assert.equal((await request(f, { ledger_entry_ids: awardId }, options)).body.certificates[awardId].available, false);
    assert.equal((await request(f, {}, options)).statusCode, 404);
    f.db.rows[source === 'booking' ? 'event' : 'complex_event'].push(event);
    const failed = await request(f, {}, { ...options, renderAttendeeCertificate: async () => {
      throw new Error('private source path');
    } });
    assert.equal(failed.statusCode, 503);
    assert.doesNotMatch(JSON.stringify(failed.body), /private source path/);
    const changed = await request(f, {}, { ...options, renderAttendeeCertificate: async () => {
      f.db.rows.member_cpd_points_ledger.push(reversal);
      return Buffer.from('not a PDF');
    } });
    assert.equal(changed.statusCode, 409);
    assert.notEqual(changed.headers['Content-Type'], 'application/pdf');
    f.db.rows.member_cpd_points_ledger.pop();
    const replacedBooking = await request(f, {}, { ...options, renderAttendeeCertificate: async () => {
      f.db.rows.member_cpd_points_ledger[0].booking_id = '99999999-9999-4999-8999-999999999999';
      f.db.rows[source].push({ ...f.db.rows[source][0], id: '99999999-9999-4999-8999-999999999999' });
      return Buffer.from('not a PDF');
    } });
    assert.equal(replacedBooking.statusCode, 409);
    assert.notEqual(replacedBooking.headers['Content-Type'], 'application/pdf');
    f.db.rows.member_cpd_points_ledger[0].booking_id = bookingId;
    const changedEvent = await request(f, {}, { ...options, renderAttendeeCertificate: async () => {
      f.db.rows[source === 'booking' ? 'event' : 'complex_event'].pop();
      return Buffer.from('not a PDF');
    } });
    assert.equal(changedEvent.statusCode, 409);
    assert.notEqual(changedEvent.headers['Content-Type'], 'application/pdf');
  }
});