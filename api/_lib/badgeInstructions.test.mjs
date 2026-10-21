import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { validatePdf, parseSetting, publicConfig, createBadgeInstructionsService, MAX_PDF_BYTES } from './badgeInstructions.js';
import { createHandler } from '../badge-instructions.js';
import { rejectGenericServerOwnedEntity } from './serverOwnedEntityBoundary.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const otherTenant = '00000000-0000-4000-8000-000000000002';
const docId = '10000000-0000-4000-8000-000000000001';
const doc = { id: docId, path: `${tenantId}/${docId}.pdf`, filename: 'Guidance.pdf', size: 123 };
const standard = { mode: 'standard', revision: null, document: null };
const retained = { mode: 'standard', revision: 'r1', document: doc };
const pdfMode = { ...retained, mode: 'pdf' };
async function pdfBody() {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return { filename: 'Instructions.pdf', mimeType: 'application/pdf',
    contentBase64: Buffer.from(await pdf.save()).toString('base64') };
}
function response() {
  return { headers: {}, code: null, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(v) { this.code = v; return this; },
    json(v) { this.body = v; return this; },
    send(v) { this.body = v; return this; },
  };
}
async function request({ method = 'GET', query = {}, body, context = { tenantId, isAuthenticated: true },
  admin = false, config = standard, overrides = {} } = {}) {
  const calls = [];
  const service = {
    read: async (...args) => { calls.push(['read', ...args]); return config; },
    document: async (...args) => { calls.push(['document', ...args]); return Buffer.from('%PDF-test'); },
    upload: async (...args) => { calls.push(['upload', ...args]); return retained; },
    mutate: async (...args) => { calls.push(['mutate', ...args]); return standard; },
    deleteDocument: async (...args) => { calls.push(['deleteDocument', ...args]); return standard; },
    cleanup: async () => undefined,
    ...overrides,
  };
  const handler = createHandler({ service, contextFor: async () => context, adminFor: async () => admin });
  const res = response();
  await handler({ method, query, body }, res);
  return { res, calls };
}

test('real readable PDF accepted, strict MIME, name, content and size enforced', async () => {
  const body = await pdfBody();
  assert.ok((await validatePdf(body)).length > 0);
  for (const invalid of [
    { mimeType: 'image/png' }, { filename: '../test.pdf' }, { filename: 'x.pdf\n' },
    { filename: 'x.txt' }, { contentBase64: '!!!!' },
    { contentBase64: Buffer.from('not a pdf').toString('base64') },
    { contentBase64: Buffer.alloc(MAX_PDF_BYTES + 1).toString('base64') },
    { contentBase64: body.contentBase64.slice(0, -12) },
  ]) await assert.rejects(validatePdf({ ...body, ...invalid }), e => e.status === 400 || e.status === 413);
});
test('empty and active PDFs rejected', async () => {
  const empty = await PDFDocument.create();
  await assert.rejects(validatePdf({ ...(await pdfBody()),
    contentBase64: Buffer.from(await empty.save({ addDefaultPage: false })).toString('base64') }));
  const active = await PDFDocument.create();
  active.addPage();
  active.catalog.set(PDFName.of('OpenAction'), active.context.obj({ S: 'JavaScript', JS: 'alert(1)' }));
  await assert.rejects(validatePdf({ ...(await pdfBody()),
    contentBase64: Buffer.from(await active.save()).toString('base64') }));
});
test('missing, malformed and cross-tenant metadata default safely', () => {
  for (const row of [null, { setting_value: '{bad' }, { setting_value: '{"mode":"pdf"}' },
    { setting_value: JSON.stringify({ ...pdfMode, document: { ...doc, path: `${otherTenant}/${docId}.pdf` } }) }]) {
    const result = parseSetting(row, tenantId);
    assert.equal(result.mode, 'standard');
    assert.equal(result.document, null);
  }
  const parsed = parseSetting({ setting_value: JSON.stringify(pdfMode) }, tenantId);
  assert.equal(parsed.mode, 'pdf');
  const exposed = publicConfig(tenantId, parsed, false);
  assert.deepEqual(exposed.document, { filename: doc.filename, size: doc.size });
  assert.ok(!JSON.stringify(exposed).includes(doc.path));
});
test('private ledger and PDF recovery copies are inaccessible through all generic aliases', () => {
  for (const entity of ['BadgeInstructionObject', 'badge_instruction_object', 'badge-instruction-object']) {
    const res = response();
    assert.equal(rejectGenericServerOwnedEntity(entity, res), true);
    assert.equal(res.code, 403);
  }
});
test('member reads own config, default stable API, no unrelated setting payload', async () => {
  const { res, calls } = await request();
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { tenantId, ...standard, canManage: false });
  assert.deepEqual(calls, [['read', tenantId]]);
  assert.match(res.headers['Cache-Control'], /no-store/);
});
test('anonymous requests denied, all member mutations denied', async () => {
  assert.equal((await request({ context: { tenantId, isAuthenticated: false } })).res.code, 401);
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const { res, calls } = await request({ method, body: { revision: null } });
    assert.equal(res.code, 403);
    assert.equal(calls.length, 0);
  }
});
test('authenticated tenant mismatch rejected before any reads or writes', async () => {
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const { res, calls } = await request({ method, admin: true,
      context: { tenantId, isAuthenticated: true, tenantMismatch: true },
      body: { revision: null, confirm: true, mode: 'standard' } });
    assert.equal(res.code, 403);
    assert.equal(calls.length, 0);
  }
  const { res } = await request({ query: { document: 'true', tenantId },
    context: { tenantId, isAuthenticated: true, tenantMismatch: true } });
  assert.equal(res.code, 403);
  assert.match(res.body, /sharing-your-membership-badge/);
});
test('document requires exact tenant pin; arbitrary tenant is never used as authority', async () => {
  for (const query of [{ document: 'true' }, { document: 'true', tenantId: otherTenant }, { tenantId: otherTenant }]) {
    const { res, calls } = await request({ query });
    assert.equal(res.code, 403);
    assert.equal(calls.length, 0);
  }
});
test('member cannot preview retained standard PDF, admin can; enabled PDF streams privately', async () => {
  const query = { document: 'true', tenantId };
  assert.equal((await request({ query, config: retained })).res.code, 404);
  for (const options of [{ admin: true, config: retained }, { config: pdfMode }]) {
    const { res } = await request({ query, ...options });
    assert.equal(res.code, 200);
    assert.equal(res.headers['Content-Type'], 'application/pdf');
    assert.match(res.headers['Cache-Control'], /no-store/);
    assert.match(res.headers['Content-Disposition'], /inline/);
    assert.ok(Buffer.isBuffer(res.body));
  }
});
test('delivery errors always show safe accessible help fallback, not raw storage errors', async () => {
  const { res } = await request({ query: { document: 'true', tenantId }, config: pdfMode,
    overrides: { document: async () => { throw new Error('secret bucket credentials'); } } });
  assert.equal(res.code, 503);
  assert.match(res.body, /\/help\/sharing-your-membership-badge/);
  assert.ok(!res.body.includes('secret'));
  assert.match(res.headers['Content-Type'], /text\/html/);
});
test('mutations require revision, mode, upload action and explicit confirmation', async () => {
  for (const [method, body] of [
    ['POST', {}], ['POST', { action: 'other', revision: null }],
    ['PATCH', { revision: null, mode: 'unknown' }],
    ['DELETE', { revision: null, confirm: false }],
    ['DELETE', { revision: null }], ['PATCH', { mode: 'standard' }],
  ]) {
    const { res, calls } = await request({ method, body, admin: true });
    assert.equal(res.code, 400);
    assert.equal(calls.length, 0);
  }
});
test('admin upload retains mode, standard switch retains document, PDF selection verifies retained bytes', async () => {
  const body = { revision: 'r1', action: 'upload', ...(await pdfBody()) };
  const uploaded = await request({ method: 'POST', body, admin: true });
  assert.equal(uploaded.res.body.mode, 'standard');
  assert.deepEqual(uploaded.calls[0], ['upload', tenantId, 'r1', body]);
  const switched = await request({ method: 'PATCH', body: { revision: 'r1', mode: 'standard' },
    admin: true, config: pdfMode, overrides: { mutate: async () => retained } });
  assert.deepEqual(switched.res.body.document, { filename: doc.filename, size: doc.size });
  const enabled = await request({ method: 'PATCH', body: { revision: 'r1', mode: 'pdf' }, admin: true, config: retained });
  assert.deepEqual(enabled.calls.map(c => c[0]), ['read', 'document', 'mutate']);
});
test('confirmed deletion only derives target server-side and explicit cleanup warning survives', async () => {
  const { res, calls } = await request({ method: 'DELETE', admin: true,
    body: { revision: 'r1', confirm: true, path: 'attacker/object' },
    overrides: { cleanup: async () => 'Cleanup pending' } });
  assert.equal(res.code, 200);
  assert.deepEqual(calls, [['deleteDocument', tenantId, 'r1']]);
  assert.equal(res.body.warning, 'Cleanup pending');
});
test('standard-mode retry works after deletion with no retained document', async () => {
  const { res, calls } = await request({ method: 'PATCH', admin: true,
    body: { revision: 'after-delete', mode: 'standard' }, config: standard });
  assert.equal(res.code, 200);
  assert.equal(res.body.document, null);
  assert.deepEqual(calls, [['mutate', tenantId, 'mode', { p_revision: 'after-delete', p_mode: 'standard' }]]);
});

function fakeDb({ rpc, upload, remove, download, garbage = [], setting, ledger } = {}) {
  const calls = [];
  const db = {
    calls,
    rpc: async (name, args) => { calls.push(['rpc', args.p_action, args]); return rpc ? rpc(args) : { data: standard }; },
    storage: { from(bucket) {
      assert.equal(bucket, 'badge-instructions');
      return {
        upload: async (...args) => { calls.push(['storage-upload', ...args]); return upload ? upload(...args) : {}; },
        remove: async paths => { calls.push(['storage-remove', paths]); return remove ? remove(paths) : {}; },
        download: async path => download(path),
      };
    } },
    from(table) {
      const query = { select() { return this; }, eq() { return this; },
        limit: async () => ({ data: garbage }),
        maybeSingle: async () => ({ data: table === 'system_settings'
          ? (setting ? { setting_value: JSON.stringify(setting) } : null) : ledger || null }) };
      return query;
    },
  };
  return db;
}
test('service reserves before upload, commits only after successful private upload', async () => {
  const db = fakeDb();
  await createBadgeInstructionsService(db).upload(tenantId, null, await pdfBody());
  assert.deepEqual(db.calls.map(c => c[0] === 'rpc' ? c[1] : c[0]), ['prepare', 'storage-upload', 'upload']);
  assert.equal(db.calls[1][3].upsert, false);
});
test('quota and CAS errors prevent upload and return actionable statuses', async () => {
  for (const [code, status] of [['P0002', 402], ['40001', 409], ['22023', 400], ['XX000', 503]]) {
    const db = fakeDb({ rpc: () => ({ error: { code } }) });
    await assert.rejects(createBadgeInstructionsService(db).upload(tenantId, null, await pdfBody()), e => e.status === status);
    assert.equal(db.calls.length, 1);
  }
});
test('failed upload or CAS replacement abandons only new object and cleans owned garbage', async () => {
  for (const failUpload of [true, false]) {
    let newId;
    const db = fakeDb({
      rpc: args => {
        if (args.p_action === 'prepare') newId = args.p_object_id;
        if (args.p_action === 'upload') return { error: { code: '40001' } };
        if (args.p_action === 'abandon') assert.equal(args.p_object_id, newId);
        return { data: standard };
      },
      upload: () => failUpload ? { error: new Error('storage') } : {},
    });
    await assert.rejects(createBadgeInstructionsService(db).upload(tenantId, 'r1', await pdfBody()));
    assert.ok(db.calls.some(c => c[1] === 'abandon'));
    assert.ok(!db.calls.some(c => c[0] === 'storage-remove' && c[1].includes(doc.path)));
  }
});
test('cleanup never acknowledges failed removal; retries leave explicit warning and accounting reserved', async () => {
  const db = fakeDb({ garbage: [{ id: docId, path: doc.path }], remove: () => ({ error: new Error('storage unavailable') }) });
  assert.match(await createBadgeInstructionsService(db).cleanup(tenantId), /cleanup is pending/);
  assert.ok(!db.calls.some(c => c[1] === 'cleanup_ack'));
});
test('cleanup refuses foreign paths, successful cleanup acknowledges only owned immutable IDs', async () => {
  const bad = fakeDb({ garbage: [{ id: docId, path: `${otherTenant}/${docId}.pdf` }] });
  assert.ok(await createBadgeInstructionsService(bad).cleanup(tenantId));
  assert.ok(!bad.calls.some(c => c[0] === 'storage-remove'));
  const good = fakeDb({ garbage: [{ id: docId, path: doc.path }] });
  assert.equal(await createBadgeInstructionsService(good).cleanup(tenantId), undefined);
  assert.ok(good.calls.some(c => c[1] === 'cleanup_ack' && c[2].p_object_id === docId));
});
test('delivery rejects missing, size-mismatched and corrupt PDF storage bytes', async () => {
  for (const output of [{ error: new Error('missing') }, { data: new Blob(['bad']) },
    { data: new Blob([Buffer.alloc(doc.size)]) }]) {
    const service = createBadgeInstructionsService(fakeDb({ download: () => output }));
    await assert.rejects(service.document(tenantId, pdfMode), e => e.status === 503);
  }
});
test('failed storage deletion retains durable claim and working config, never writes an orphan restore', async () => {
  const body = await pdfBody();
  const bytes = Buffer.from(body.contentBase64, 'base64');
  const current = { ...pdfMode, document: { ...doc, size: bytes.length } };
  const db = fakeDb({ setting: current, download: () => ({ data: new Blob([bytes]) }),
    remove: () => ({ error: new Error('ambiguous storage failure') }),
    rpc: () => ({ data: current }) });
  await assert.rejects(createBadgeInstructionsService(db).deleteDocument(tenantId, 'r1'),
    e => e.status === 503 && /configuration is unchanged/.test(e.message));
  const actions = db.calls.map(c => c[0] === 'rpc' ? c[1] : c[0]);
  assert.deepEqual(actions, ['begin_delete', 'storage-remove']);
  assert.ok(!actions.includes('finish_delete'));
});
test('successful deletion finalizes only after physical removal and stale deletion cannot remove', async () => {
  const body = await pdfBody();
  const bytes = Buffer.from(body.contentBase64, 'base64');
  const current = { ...pdfMode, document: { ...doc, size: bytes.length } };
  const db = fakeDb({ setting: current, download: () => ({ data: new Blob([bytes]) }) });
  await createBadgeInstructionsService(db).deleteDocument(tenantId, 'r1');
  assert.deepEqual(db.calls.map(c => c[0] === 'rpc' ? c[1] : c[0]),
    ['begin_delete', 'storage-remove', 'finish_delete']);
  const stale = fakeDb({ setting: current });
  await assert.rejects(createBadgeInstructionsService(stale).deleteDocument(tenantId, 'stale'), e => e.status === 409);
  assert.equal(stale.calls.length, 0);
});
test('interrupted deletion serves durable recovery PDF and can be retried to finalize', async () => {
  const body = await pdfBody();
  const bytes = Buffer.from(body.contentBase64, 'base64');
  const current = { ...pdfMode, document: { ...doc, size: bytes.length } };
  const db = fakeDb({ setting: current, download: () => ({ error: true }),
    ledger: { deletion_backup: body.contentBase64 },
    rpc: args => args.p_action === 'finish_delete' ? { error: { code: 'XX000' } } : { data: current } });
  const service = createBadgeInstructionsService(db);
  assert.deepEqual(await service.document(tenantId, current), bytes);
  await assert.rejects(service.deleteDocument(tenantId, 'r1'), e => /could not be confirmed/.test(e.message));
  assert.deepEqual(await service.document(tenantId, current), bytes);
});
test('ambiguous failed deletion retains recovery claim, never clears backup or reports success', async () => {
  const body = await pdfBody();
  const bytes = Buffer.from(body.contentBase64, 'base64');
  const current = { ...pdfMode, document: { ...doc, size: bytes.length } };
  const db = fakeDb({ setting: current, download: () => ({ data: new Blob([bytes]) }),
    remove: () => ({ error: true }), upload: () => ({ error: true }), rpc: () => ({ data: current }) });
  await assert.rejects(createBadgeInstructionsService(db).deleteDocument(tenantId, 'r1'),
    e => e.status === 503 && /private recovery copy/.test(e.message));
  assert.ok(!db.calls.some(c => ['cancel_delete', 'finish_delete'].includes(c[1])));
});
