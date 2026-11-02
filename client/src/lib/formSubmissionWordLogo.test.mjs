import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import JSZip from 'jszip';
import { Packer } from 'docx';
import { fitTenantLogo, loadTenantLogo, buildSubmissionsDocument } from './formSubmissionWordExport.js';

for (const [width, height] of [[400, 100], [100, 400], [100, 100]]) {
  test(`DOCX retains ${width}:${height} logo ratio`, async (t) => {
    const data = await sharp({ create: { width, height, channels: 4, background: '#ffffff' } }).png().toBuffer();
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(data).buffer }));
    const logo = await loadTenantLogo('https://fixture.test/logo?image=1');
    assert.equal(logo.type, 'png');
    const dimensions = fitTenantLogo(logo.width, logo.height);
    assert.equal(dimensions.width / dimensions.height, width / height);
    assert.ok(dimensions.width <= 160 && dimensions.height <= 60);
    const doc = buildSubmissionsDocument({ submissions: [], formsById: {}, selectedOptions: {}, resolvers: {}, tenantLogo: logo, documentTitle: 'Test' });
    const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
    const xml = await zip.file('word/document.xml').async('string');
    const extent = xml.match(/wp:extent cx="(\d+)" cy="(\d+)"/);
    assert.ok(extent);
    assert.equal(Number(extent[1]) / Number(extent[2]), width / height);
  });
}

test('corrupt images are omitted instead of stretched', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }));
  assert.equal(await loadTenantLogo('https://fixture.test/bad.png'), null);
});
