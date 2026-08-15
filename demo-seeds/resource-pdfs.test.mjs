// Tests for demo-seeds/resource-pdfs.mjs
// Run: node --test demo-seeds/resource-pdfs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_RESOURCE_PDF_BUCKET,
  demoResourcePdfStoragePath,
  buildResourcePdfBuffer,
  seedDemoResourcePdfs,
  youtubeEmbedCode,
} from './resource-pdfs.mjs';
import { RESOURCES, VIDEO_RESOURCES } from './aesp/engagement.mjs';

const TENANT_ID = 't-demo';
const BRAND = { orgName: 'AESP', primaryColor: '#174A3A', accentColor: '#D5A642', footer: 'AESP — demo' };

const SPEC = {
  title: 'Test Guidance',
  subtitle: 'A test document',
  sections: [
    { heading: 'Section one', paragraphs: ['First paragraph of body text. '.repeat(12)] },
    { heading: 'Section two', paragraphs: ['More text. '.repeat(30)], bullets: ['Bullet a', 'Bullet b '.repeat(10)] },
  ],
};

test('storage path is deterministic and sanitised', () => {
  const p1 = demoResourcePdfStoragePath(TENANT_ID, 'cpd-guidance');
  assert.equal(p1, `${TENANT_ID}/demo-resources/cpd-guidance.pdf`);
  assert.equal(p1, demoResourcePdfStoragePath(TENANT_ID, 'cpd-guidance'));
  assert.match(demoResourcePdfStoragePath(TENANT_ID, ' Weird/Slug !! '), /^t-demo\/demo-resources\/[a-z0-9-]+\.pdf$/);
});

test('buildResourcePdfBuffer produces a valid, byte-stable PDF', () => {
  const b1 = buildResourcePdfBuffer(SPEC, BRAND);
  const b2 = buildResourcePdfBuffer(SPEC, BRAND);
  assert.ok(Buffer.isBuffer(b1));
  assert.equal(b1.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(b1.length > 2000);
  assert.ok(b1.equals(b2), 'PDF output must be byte-stable across runs');
});

test('long content spills onto multiple pages', () => {
  const long = {
    title: 'Long Doc',
    sections: Array.from({ length: 10 }, (_, i) => ({
      heading: `Section ${i + 1}`,
      paragraphs: ['Body text for the long document. '.repeat(40)],
    })),
  };
  const buf = buildResourcePdfBuffer(long, BRAND).toString('latin1');
  const pageCount = (buf.match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.ok(pageCount >= 2, `expected multi-page PDF, got ${pageCount} page(s)`);
});

test('buildResourcePdfBuffer rejects specs without sections', () => {
  assert.throws(() => buildResourcePdfBuffer({ title: 'X', sections: [] }, BRAND));
  assert.throws(() => buildResourcePdfBuffer({ sections: [{ heading: 'h' }] }, BRAND));
});

test('youtubeEmbedCode builds the standard iframe and sanitises the id', () => {
  const html = youtubeEmbedCode('GK_vRtHJZu4', 'Why "Biodiversity" Matters');
  assert.match(html, /^<iframe /);
  assert.ok(html.includes('https://www.youtube-nocookie.com/embed/GK_vRtHJZu4'));
  assert.ok(html.includes('allowfullscreen'));
  assert.ok(html.includes('&quot;Biodiversity&quot;'));
  assert.ok(!youtubeEmbedCode('abc"/><script>').includes('<script>'));
});

function mockCtx({ uploads = [], upserts = [], storageObjects = [] } = {}) {
  const sb = {
    storage: {
      from: (bucket) => ({
        upload: async (path, buffer, opts) => {
          uploads.push({ bucket, path, size: buffer.length, upsert: opts?.upsert });
          return { error: null };
        },
        getPublicUrl: (path) => ({ data: { publicUrl: `https://cdn.example.com/${bucket}/${path}` } }),
      }),
    },
  };
  let nextId = 1;
  return {
    ctx: {
      sb,
      tenantId: TENANT_ID,
      recordStorageObject: (bucket, path) => {
        if (!storageObjects.some((o) => o.bucket === bucket && o.path === path)) storageObjects.push({ bucket, path });
      },
      upsert: async (table, match, row) => {
        upserts.push({ table, match, row });
        return { id: `fr-${nextId++}` };
      },
    },
    uploads, upserts, storageObjects,
  };
}

test('seedDemoResourcePdfs uploads, registers and records each PDF idempotently', async () => {
  const { ctx, uploads, upserts, storageObjects } = mockCtx();
  const items = [
    { slug: 'doc-a', title: 'Doc A', description: 'First doc', pdf: SPEC },
    { slug: 'doc-b', title: 'Doc B', pdf: { title: 'Doc B', sections: SPEC.sections } },
  ];
  const out = await seedDemoResourcePdfs({ ctx, items, brand: BRAND, uploadedBy: 'owner@demo.example.com' });

  assert.equal(out.size, 2);
  const a = out.get('doc-a');
  assert.match(a.url, /demo-resources\/doc-a\.pdf$/);
  assert.equal(a.fileRepositoryId, 'fr-1');
  assert.ok(a.sizeBytes > 0);

  // Uploads go to the public bucket with upsert (re-runs overwrite).
  assert.equal(uploads.length, 2);
  assert.ok(uploads.every((u) => u.bucket === DEMO_RESOURCE_PDF_BUCKET && u.upsert === true));

  // file_repository rows carry bucket + storage_path + document metadata.
  assert.equal(upserts.length, 2);
  const row = upserts[0];
  assert.equal(row.table, 'file_repository');
  assert.deepEqual(row.match, { file_name: 'doc-a.pdf' });
  assert.equal(row.row.file_type, 'document');
  assert.equal(row.row.mime_type, 'application/pdf');
  assert.equal(row.row.bucket, DEMO_RESOURCE_PDF_BUCKET);
  assert.equal(row.row.storage_path, demoResourcePdfStoragePath(TENANT_ID, 'doc-a'));
  assert.equal(row.row.description, 'First doc');
  assert.equal(row.row.uploaded_by, 'owner@demo.example.com');

  // Storage objects recorded for reset cleanup; re-run stays deduped.
  assert.equal(storageObjects.length, 2);
  await seedDemoResourcePdfs({ ctx, items, brand: BRAND });
  assert.equal(storageObjects.length, 2, 'deterministic paths must not duplicate storage records');
});

test('removeSeededStorageObjects keeps failed paths for the next reset to retry', async () => {
  const { removeSeededStorageObjects } = await import('./engine.mjs');
  const calls = [];
  const sb = {
    storage: {
      from: (bucket) => ({
        remove: async (paths) => {
          calls.push({ bucket, paths });
          return bucket === 'flaky-bucket' ? { error: new Error('transient storage failure') } : { error: null };
        },
      }),
    },
  };
  const objects = [
    { bucket: 'public-assets', path: 't/demo-resources/a.pdf' },
    { bucket: 'flaky-bucket', path: 't/demo-resources/b.pdf' },
    { bucket: null, path: 'ignored' },
  ];
  const { removedCount, failed } = await removeSeededStorageObjects(sb, objects, () => {});
  assert.equal(removedCount, 1);
  assert.deepEqual(failed, [{ bucket: 'flaky-bucket', path: 't/demo-resources/b.pdf' }]);
  assert.equal(calls.length, 2);
  // Empty/absent input is a no-op.
  assert.deepEqual(await removeSeededStorageObjects(sb, [], () => {}), { removedCount: 0, failed: [] });
  assert.deepEqual(await removeSeededStorageObjects(sb, null, () => {}), { removedCount: 0, failed: [] });
});

test('AESP definitions carry authored PDF content and hardcoded video ids', () => {
  assert.equal(RESOURCES.length, 6);
  for (const r of RESOURCES) {
    assert.ok(r.slug && r.title && r.desc, `${r.title}: base fields`);
    assert.ok(Array.isArray(r.pdf?.sections) && r.pdf.sections.length >= 3, `${r.title}: needs authored sections`);
    for (const s of r.pdf.sections) {
      assert.ok(s.heading, `${r.title}: section heading`);
      assert.ok((s.paragraphs?.length || 0) + (s.bullets?.length || 0) > 0, `${r.title}: section body`);
    }
    // Content must actually render (2–4 page docs).
    const buf = buildResourcePdfBuffer({ title: r.title, subtitle: r.pdf.subtitle, sections: r.pdf.sections }, BRAND);
    assert.ok(buf.length > 4000, `${r.title}: renders a substantive PDF`);
  }
  assert.ok(VIDEO_RESOURCES.length >= 2 && VIDEO_RESOURCES.length <= 3);
  const publics = VIDEO_RESOURCES.filter((v) => v.isPublic).length;
  assert.ok(publics >= 1 && publics < VIDEO_RESOURCES.length, 'video visibility should be mixed');
  for (const v of VIDEO_RESOURCES) {
    assert.match(v.youtubeId, /^[A-Za-z0-9_-]{11}$/, `${v.title}: hardcoded YouTube id`);
    assert.match(youtubeEmbedCode(v.youtubeId, v.title), /youtube-nocookie\.com\/embed\//);
  }
});
