import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { reformatSignedSalesAgreements } from './salesAgreementReformat.js';
import { downloadSalesAgreement } from './salesAgreement.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture({ failUpload = false } = {}) {
  const original = Buffer.from('%PDF-original-signed');
  const files = new Map([['tenant/env-1/final.pdf', original]]);
  const snapshot = { quote: { quote_number: 'Q1' }, version: { id: 'v1' }, tenant: { name: 'Seller' } };
  const envelope = { id: 'env-1', tenant_id: 'tenant', quote_version_id: 'v1', snapshot, customer: { name: 'Buyer' },
    sender: { name: 'Seller' }, document_hash: 'd'.repeat(64), finalization_status: 'complete',
    final_pdf_path: 'tenant/env-1/final.pdf', final_pdf_hash: sha(original), finalized_at: '2026-10-23T00:00:00Z' };
  const pending = { ...envelope, id: 'env-2', customer: null, finalization_status: 'pending', final_pdf_path: null, final_pdf_hash: null };
  const rows = [envelope, pending];
  const history = []; const uploads = []; const rpcs = [];
  const storage = {
    download: async path => files.has(path) ? { data: new Blob([files.get(path)]) } : { error: { message: 'not found' } },
    upload: async (path, body, options) => {
      assert.equal(options.upsert, false);
      if (failUpload) return { error: { message: 'storage down' } };
      if (files.has(path)) return { error: { statusCode: '409' } };
      uploads.push(path); files.set(path, Buffer.from(body)); return {};
    },
  };
  const db = {
    storage: { from: bucket => { assert.equal(bucket, 'sales-agreements'); return storage; } },
    from: table => {
      assert.equal(table, 'sales_agreement_envelope');
      const filters = [];
      const q = { select() { return q; }, order() { return q; }, range() { return q; },
        eq(column, value) { filters.push([column, value]); return q; },
        then(resolve) { resolve({ data: rows.filter(r => filters.every(([c, v]) => r[c] === v)).map(r => structuredClone(r)) }); } };
      return q;
    },
    rpc: async (name, args) => {
      rpcs.push(name);
      assert.equal(name, 'supersede_sales_agreement_final_pdf');
      const row = rows.find(r => r.id === args.p_envelope_id);
      if (row.final_pdf_path !== args.p_expected_path || row.final_pdf_hash !== args.p_expected_hash) return { data: { ok: false, reason: 'changed_concurrently' } };
      history.push({ envelope_id: row.id, superseded_path: row.final_pdf_path, superseded_hash: row.final_pdf_hash,
        replacement_path: args.p_new_path, replacement_hash: args.p_new_hash, layout: args.p_layout });
      row.final_pdf_path = args.p_new_path; row.final_pdf_hash = args.p_new_hash;
      return { data: { ok: true, changed: true } };
    },
  };
  return { db, files, rows, envelope, history, uploads, rpcs, original, snapshot };
}

const options = { loadContext: async () => ({ quoteSingular: 'Proposal' }),
  buildPdf: async (envelope, context) => Buffer.from(`%PDF-new-layout ${context.quoteSingular} ${envelope.snapshot.quote.quote_number}`) };

test('dry run reports work without writing anything', async () => {
  const f = fixture();
  const results = await reformatSignedSalesAgreements(f.db, { dryRun: true, ...options });
  assert.deepEqual(results.map(r => r.status), ['would_reformat']);
  assert.equal(f.uploads.length, 0); assert.equal(f.rpcs.length, 0);
});

test('apply retains the original, switches to a verified new file, and a second run does nothing', async () => {
  const f = fixture();
  const snapshotBefore = structuredClone(f.rows[0].snapshot);
  const [result] = await reformatSignedSalesAgreements(f.db, { dryRun: false, ...options });
  assert.equal(result.status, 'reformatted');
  const row = f.rows[0];
  assert.equal(row.final_pdf_path, 'tenant/env-1/final-proposal-layout-v2.pdf');
  // Original kept in storage and recorded as superseded history.
  assert.deepEqual(f.files.get('tenant/env-1/final.pdf'), f.original);
  assert.deepEqual(f.history, [{ envelope_id: 'env-1', superseded_path: 'tenant/env-1/final.pdf', superseded_hash: sha(f.original),
    replacement_path: row.final_pdf_path, replacement_hash: row.final_pdf_hash, layout: 'proposal-layout-v2' }]);
  // The active file passes the standard download integrity check.
  const downloaded = await downloadSalesAgreement(f.db, row);
  assert.match(downloaded.toString(), /^%PDF-new-layout Proposal Q1/);
  // Signed evidence is untouched.
  assert.deepEqual(row.snapshot, snapshotBefore);
  assert.equal(row.document_hash, 'd'.repeat(64));
  const again = await reformatSignedSalesAgreements(f.db, { dryRun: false, ...options });
  assert.deepEqual(again.map(r => [r.status, r.reason]), [['skipped', 'already_reformatted']]);
  assert.equal(f.uploads.length, 1); assert.equal(f.history.length, 1);
});

test('failures leave the original active and are reported', async () => {
  const f = fixture({ failUpload: true });
  const [result] = await reformatSignedSalesAgreements(f.db, { dryRun: false, ...options });
  assert.equal(result.status, 'failed');
  assert.equal(f.rows[0].final_pdf_path, 'tenant/env-1/final.pdf');
  assert.equal(f.history.length, 0);
  const tampered = fixture();
  tampered.files.set('tenant/env-1/final.pdf', Buffer.from('%PDF-tampered'));
  const [integrity] = await reformatSignedSalesAgreements(tampered.db, { dryRun: false, ...options });
  assert.equal(integrity.status, 'failed');
  assert.match(integrity.reason, /original_unavailable/);
  assert.equal(tampered.uploads.length, 0);
});

test('a file left by an interrupted run is reused, never overwritten', async () => {
  const f = fixture();
  const leftover = Buffer.from('%PDF-from-interrupted-run');
  f.files.set('tenant/env-1/final-proposal-layout-v2.pdf', leftover);
  const [result] = await reformatSignedSalesAgreements(f.db, { dryRun: false, ...options });
  assert.equal(result.status, 'reformatted');
  assert.equal(f.rows[0].final_pdf_hash, sha(leftover));
  assert.equal(f.uploads.length, 0);
});
