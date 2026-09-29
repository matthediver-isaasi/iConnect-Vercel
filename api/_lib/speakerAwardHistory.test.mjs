import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME = '1';
const { __setRoleAccessOverlayForTests } = await import('./roleVisibility.js');
__setRoleAccessOverlayForTests([]);
const { createSpeakerAwardHistoryHandler, speakerHistoryPagination } = await import('./speakerAwardHistory.js');
const { createSpeakerCertificateHandler } = await import('../speaker-awards/certificate.js');
const { createSpeakerCertificateTemplatesHandler } = await import('../admin/speakers/certificate-templates.js');

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const pdf = Buffer.from('%PDF-1.7\nspeaker certificate');
function fixture({ exclusions = [], role = true, member = true, memberId = id(2), staff = false, row = {}, revokeOnRead = false } = {}) {
  const calls = [];
  let reads = 0;
  const recognition = {
    id: id(3), tenant_id: id(1), member_id: id(2), status: 'active', certificate_status: 'issued',
    pdf_path: `${id(1)}/${id(3)}.pdf`, pdf_sha256: createHash('sha256').update(pdf).digest('hex'), ...row,
  };
  const db = {
    from(table) {
      const filters = [];
      const query = {
        select(...args) { calls.push(['select', table, ...args]); return query; },
        eq(key, value) { filters.push([key, value]); calls.push(['eq', table, key, value]); return query; },
        order() { return query; },
        range(...args) { calls.push(['range', ...args]); return query; },
        maybeSingle() { return query; },
        then(resolve) {
          let data;
          if (table === 'role') data = role ? { excluded_features: exclusions } : null;
          if (table === 'speaker') data = { id: id(5) };
          if (table === 'speaker_award_history') data = [{
            id: id(3), event_type: 'event', event_id: id(4), event_title: 'Conference',
            status: 'active', certificate_status: 'error', certificate_available: false,
            badge_name: 'Speaker', badge_status: 'active', badge_evidence: 'existing_member_badge',
            snapshot: { private: 'must never appear' }, pdf_path: 'must never appear',
          }];
          if (table === 'cpd_certificate_template') data = [{ id: id(8), name: 'Active template' }];
          if (table === 'speaker_recognition') {
            reads++;
            data = filters.every(([key, value]) => recognition[key] === value)
              ? { ...recognition, ...(revokeOnRead && reads > 1 ? { status: 'revoked' } : {}) } : null;
          }
          resolve({ data, error: null, count: Array.isArray(data) ? data.length : null });
        },
      };
      return query;
    },
    storage: { from(bucket) {
      calls.push(['bucket', bucket]);
      return { async download(path) { calls.push(['download', path]); return { data: new Blob([pdf]) }; } };
    } },
  };
  const dependencies = {
    db, tenantContext: async () => staff ? { isAuthenticated: true, tenantId: id(1), roleId: id(6) } : null,
    adminAccess: async () => false,
    sessionMember: async () => member ? { id: memberId, tenant_id: id(1), role_id: id(6) } : null,
  };
  const response = () => ({
    headers: {}, code: null, body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  });
  return { dependencies, calls, response };
}

test('member history ignores forged identity; scopes both tenant and persisted recipient; no private metadata', async () => {
  const { dependencies, calls, response } = fixture();
  const res = response();
  await createSpeakerAwardHistoryHandler({ ...dependencies, member: true })({
    method: 'GET', query: { member_id: id(99), tenant_id: id(99), page: '2', page_size: '5' },
  }, res);
  assert.equal(res.code, 200);
  assert.ok(calls.some(c => c.join() === ['eq', 'speaker_award_history', 'tenant_id', id(1)].join()));
  assert.ok(calls.some(c => c.join() === ['eq', 'speaker_award_history', 'member_id', id(2)].join()));
  assert.ok(calls.some(c => c.join() === ['range', 5, 9].join()));
  assert.equal(JSON.stringify(res.body).includes('must never appear'), false);
  assert.equal(res.body.awards[0].badge.evidence, 'existing_member_badge');
  assert.match(res.headers['Cache-Control'], /no-store/);
});

test('member access fails closed for absent/dangling role and excluded CPD', async () => {
  for (const options of [{ member: false }, { role: false }, { exclusions: ['cpd.member_cpd'] }, { exclusions: ['cpd'] }]) {
    const { dependencies, response, calls } = fixture(options);
    const res = response();
    await createSpeakerAwardHistoryHandler({ ...dependencies, member: true })({ method: 'GET', query: {} }, res);
    assert.equal(res.code, 403);
    assert.equal(calls.some(c => c[1] === 'speaker_award_history'), false);
  }
});

test('staff history requires speaker management and validates ids', async () => {
  for (const exclusions of [[], ['events.speakers']]) {
    const { dependencies, response } = fixture({ staff: true, exclusions });
    const res = response();
    await createSpeakerAwardHistoryHandler(dependencies)({ method: 'GET', query: { speaker_id: id(5) } }, res);
    assert.equal(res.code, exclusions.length ? 403 : 200);
  }
  const { dependencies, response } = fixture({ staff: true });
  const res = response();
  await createSpeakerAwardHistoryHandler(dependencies)({ method: 'GET', query: { speaker_id: 'bad' } }, res);
  assert.equal(res.code, 400);
  assert.throws(() => speakerHistoryPagination({ page_size: '101' }));
  assert.throws(() => speakerHistoryPagination({ page: ['1'] }));
});

test('certificate returns verified private bytes and named attachment without writes', async () => {
  const { dependencies, calls, response } = fixture();
  const res = response();
  await createSpeakerCertificateHandler(dependencies)({ method: 'GET', query: { id: id(3), download: '1' } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, pdf);
  assert.match(res.headers['Content-Disposition'], /^attachment; filename="speaker-certificate-/);
  assert.ok(calls.some(c => c.join() === ['bucket', 'speaker-certificates'].join()));
});

test('certificate blocks wrong recipient, tenant, revoked, missing, malformed path and corruption', async () => {
  for (const [row, expected] of [
    [{ member_id: id(99) }, 404], [{ tenant_id: id(99) }, 404],
    [{ status: 'revoked' }, 409], [{ certificate_status: 'pending' }, 409],
    [{ pdf_path: `${id(99)}/${id(3)}.pdf` }, 409], [{ pdf_sha256: 'b'.repeat(64) }, 503],
  ]) {
    const { dependencies, response } = fixture({ row });
    const res = response();
    await createSpeakerCertificateHandler(dependencies)({ method: 'GET', query: { id: id(3) } }, res);
    assert.equal(res.code, expected);
    assert.equal(Buffer.isBuffer(res.body), false);
  }
  const { dependencies, response } = fixture({ revokeOnRead: true });
  const res = response();
  await createSpeakerCertificateHandler(dependencies)({ method: 'GET', query: { id: id(3) } }, res);
  assert.equal(res.code, 409);
});

test('certificate ownership stays with original persisted member after a speaker is linked elsewhere', async () => {
  for (const memberId of [id(2), id(99)]) {
    const { dependencies, response, calls } = fixture({ memberId });
    const res = response();
    await createSpeakerCertificateHandler(dependencies)({
      method: 'GET', query: { id: id(3), member_id: id(2), speaker_id: id(5) },
    }, res);
    assert.equal(res.code, memberId === id(2) ? 200 : 404);
    assert.equal(calls.some(c => c[1] === 'speaker'), false);
  }
});

test('template choices permit event managers without template-admin capability and expose only id/name', async () => {
  const { dependencies, response, calls } = fixture({ staff: true, exclusions: ['events.speakers', 'cpd.certificate-templates'] });
  const res = response();
  await createSpeakerCertificateTemplatesHandler(dependencies)({ method: 'GET', query: {} }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.templates, [{ id: id(8), name: 'Active template' }]);
  assert.ok(calls.some(c => c.join() === ['eq', 'cpd_certificate_template', 'status', 'active'].join()));
  assert.ok(calls.some(c => c.join() === ['eq', 'cpd_certificate_template', 'tenant_id', id(1)].join()));
});