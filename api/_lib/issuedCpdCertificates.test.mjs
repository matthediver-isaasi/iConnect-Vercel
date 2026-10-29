import test from 'node:test';
import assert from 'node:assert/strict';
import { retainIssuedCertificate, readIssuedCertificate, loadIssuedCertificate } from './issuedCpdCertificates.js';

function fixture() {
  let record;
  const objects = new Map();
  const db = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: record || null }; },
        async insert(value) {
          if (record) return { error: { code: '23505' } };
          record = value; return { error: null };
        },
      };
    },
    storage: { from() { return {
      async upload(path, pdf) { objects.set(path, Buffer.from(pdf)); return {}; },
      async download(path) { return { data: new Blob([objects.get(path) || 'corrupt']) }; },
      async remove(paths) { paths.forEach(path => objects.delete(path)); return {}; },
    }; } },
  };
  const resolved = { certificateIdentity: { tenantId: 'tenant', key: 'standard:booking' },
    template: { source_sha256: 'template' }, placeholders: [], values: { name: 'Person' }, awardSignature: 'award' };
  return { db, resolved, objects, record: () => record };
}

test('concurrent issuance returns one canonical PDF without replacing the winner', async () => {
  const f = fixture();
  const pdfs = await Promise.all([
    retainIssuedCertificate(f.db, f.resolved, Buffer.from('first'), 'member_download'),
    retainIssuedCertificate(f.db, f.resolved, Buffer.from('second'), 'attendee_send'),
  ]);
  assert.deepEqual(pdfs[0], pdfs[1]);
  assert.equal(f.objects.size, 1);
  assert.deepEqual(await readIssuedCertificate(f.db, f.record()), pdfs[0]);
  await assert.rejects(retainIssuedCertificate(f.db, { ...f.resolved, values: { name: 'Different' } },
    Buffer.from('third'), 'attendee_send'), /Another certificate version/);
});

test('storage corruption and database errors fail closed', async () => {
  const f = fixture();
  await retainIssuedCertificate(f.db, f.resolved, Buffer.from('valid'), 'member_download');
  f.objects.set(f.record().source_path, Buffer.from('corrupt'));
  await assert.rejects(readIssuedCertificate(f.db, f.record()), /integrity/);
  f.db.from = () => ({ select() { return this; }, eq() { return this; },
    async maybeSingle() { return { error: new Error('database unavailable') }; } });
  await assert.rejects(loadIssuedCertificate(f.db, 'tenant', 'standard:booking'), /database unavailable/);
});
