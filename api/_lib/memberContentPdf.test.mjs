import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  isTrustedTenantStoragePdf,
  readBoundedPdfStream,
  extractResourcePdfChunks,
} from './memberContentIndexer.js';

const origin = 'https://destination.example';
const path = 'tenant-a/resources/guide one.pdf';
const publicUrl = `${origin}/storage/v1/object/public/public-assets/${encodeURIComponent(path)}`;
const file = {
  id: 'file-a', tenant_id: 'tenant-a', file_url: publicUrl,
  file_name: 'guide one.pdf', file_type: 'document', mime_type: 'application/pdf',
  bucket: 'public-assets', storage_path: path,
};

test('migrated public PDFs with bucket/path are eligible on the injected destination', () => {
  assert.equal(isTrustedTenantStoragePdf(publicUrl, file, origin), true);
  assert.equal(isTrustedTenantStoragePdf(publicUrl, file, 'https://legacy.example'), false);
  assert.equal(isTrustedTenantStoragePdf(publicUrl, { ...file, storage_path: 'another.pdf' }, origin), false);
  assert.equal(isTrustedTenantStoragePdf(publicUrl, { ...file, bucket: 'private-uploads' }, origin), false);
  assert.equal(isTrustedTenantStoragePdf(`${publicUrl}?token=x`, { ...file, file_url: `${publicUrl}?token=x` }, origin), false);
});

test('PDF memory cap applies during streaming, independent of Content-Length', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readBoundedPdfStream(stream, { maxBytes: 10 }), { code: 'PDF_SIZE_LIMIT' });
  assert.equal(cancelled, true);
});

test('PDF stream timeout cancels a stalled response', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const result = readBoundedPdfStream(stream, { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

async function documentBytes({ text = 'Authorized resource PDF text', pages = 1 } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage();
    if (text) page.drawText(text, { font });
  }
  return pdf.save();
}

function database(bytes, record = file) {
  return {
    supabaseUrl: origin,
    storage: {
      from(bucket) {
        assert.equal(bucket, record.bucket);
        return {
          download(storagePath) {
            assert.equal(storagePath, record.storage_path);
            return { asStream: async () => ({ data: new Blob([bytes]).stream(), error: null }) };
          },
        };
      },
    },
    from(table) {
      const data = table === 'file_repository' ? record : [
        { content_type: 'file_repository', source_id: record.id, generation: 3 },
      ];
      const query = {
        select() { return query; },
        eq(key, value) {
          if (key === 'tenant_id') assert.equal(value, 'tenant-a');
          return query;
        },
        in() { return query; },
        maybeSingle() { return query; },
        then(resolve) { resolve({ data, error: null }); },
      };
      return query;
    },
  };
}
const resource = { id: 'resource-a', tenant_id: 'tenant-a', resource_type: 'download', title: 'Guide', target_url: publicUrl };

test('real PDF parser extracts public stored PDF text with file/page generation provenance', async () => {
  const chunks = await extractResourcePdfChunks(resource, database(await documentBytes()));
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /Authorized resource PDF text/);
  assert.deepEqual(chunks[0].provenance, {
    kind: 'resource_pdf', fileId: 'file-a', page: 1,
    dependencies: [{ contentType: 'file_repository', sourceId: 'file-a', generation: 3 }],
  });
});

test('real PDF parser supports private references without fetching the secure-url HTTP route', async () => {
  const privateFile = { ...file, bucket: 'private-uploads',
    file_url: `/api/storage/secure-url?bucket=private-uploads&path=${encodeURIComponent(path)}` };
  const chunks = await extractResourcePdfChunks(
    { ...resource, target_url: privateFile.file_url }, database(await documentBytes(), privateFile)
  );
  assert.equal(chunks[0].provenance.fileId, 'file-a');
});

test('unsupported no-text and excessive-page PDFs produce explicit index failures, not silent truncation', async () => {
  await assert.rejects(
    extractResourcePdfChunks(resource, database(await documentBytes({ text: '' }))),
    { code: 'PDF_NO_TEXT' }
  );
  await assert.rejects(
    extractResourcePdfChunks(resource, database(await documentBytes({ text: '', pages: 41 }))),
    { code: 'PDF_PAGE_LIMIT' }
  );
});

test('a misleading pdf filename cannot admit non-PDF bytes', async () => {
  await assert.rejects(extractResourcePdfChunks(resource, database(new TextEncoder().encode('<html>not pdf</html>'))),
    { code: 'PDF_INVALID_SIGNATURE' });
});