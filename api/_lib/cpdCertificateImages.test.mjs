import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PDFDocument, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { inspectSignature, readSignature, signatureHash, MAX_SIGNATURE_BYTES } from './cpdCertificateImages.js';
import { renderCpdCertificatePdf } from './cpdCertificatePdf.js';
import { certificateDependencies } from '../../shared/cpdCertificateDisplay.js';
import { renderAttendeeCertificate } from './attendeeCpdCertificate.js';

const image = async format => sharp({ create: { width: 80, height: 40, channels: 4,
  background: { r: 200, g: 0, b: 0, alpha: format === 'png' ? 0.5 : 1 } } })[format]().toBuffer();
const fieldFor = asset => ({ field_type: 'image', image_asset_id: 'asset', image_sha256: asset.sha256,
  placeholder_key: 'signature.signer', page_number: 1, x: 40, y: 50, width: 80, height: 40 });

test('decodes PNG/JPEG, retains alpha/original pixels and rejects invalid and oversized files', async () => {
  for (const format of ['png', 'jpeg']) {
    const bytes = await image(format);
    const asset = await inspectSignature(bytes);
    assert.deepEqual(asset.bytes, bytes);
    assert.equal(asset.mime_type, `image/${format}`);
    assert.equal(asset.width, 80);
    assert.equal(asset.height, 40);
  }
  await assert.rejects(inspectSignature(Buffer.from('<svg/>')), /valid single-image/);
  await assert.rejects(inspectSignature((await image('jpeg')).subarray(0, 70)), /could not be decoded/);
  await assert.rejects(inspectSignature(Buffer.alloc(MAX_SIGNATURE_BYTES + 1)), /2 MB/);
  const huge = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(inspectSignature(huge), /16 megapixels/);
});

test('private ownership and content hash are checked independently', async () => {
  const asset = await inspectSignature(await image('png'));
  const db = (binding, bytes = asset.bytes) => ({ from(table) {
    let filters = {};
    const q = { select() { return q; }, eq(k,v) { filters[k]=v; return q; },
      async maybeSingle() { return { data: filters.tenant_id !== 'tenant' ? null :
        table.endsWith('_binding') ? binding : { ...asset, content_base64: bytes.toString('base64') } }; } };
    return q;
  } });
  const identity = { tenantId: 'tenant', templateId: 'template', assetId: 'asset', sha256: asset.sha256 };
  assert.deepEqual((await readSignature(db({ asset_id: 'asset' }), identity)).bytes, asset.bytes);
  await assert.rejects(readSignature(db(null), identity), /not available for this template/);
  await assert.rejects(readSignature(db({}), { ...identity, tenantId: 'other' }), /not available/);
  await assert.rejects(readSignature(db({}, Buffer.from('tampered')), identity), /integrity/);
  assert.deepEqual(certificateDependencies(fieldFor(asset)), []);
});

test('independent PDF.js rasterization matches image placement on cropped, rotated, multi-page PDFs', async () => {
  for (const format of ['png', 'jpeg']) {
    const asset = await inspectSignature(await image(format));
    const doc = await PDFDocument.create();
    for (const rotation of [0, 90, 180, 270]) {
      const page = doc.addPage([340, 300]);
      page.setCropBox(20, 30, 260, 220);
      page.setRotation(degrees(rotation));
    }
    const fields = [1,2,3,4].map(page_number => ({ ...fieldFor(asset), page_number }));
    const source = await doc.save();
    const output = await renderCpdCertificatePdf(source, fields, {}, { resolveImage: async () => asset });
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(output), disableWorker: true }).promise;
    for (let i=1;i<=4;i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const canvas = createCanvas(viewport.width, viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const pixel = (x,y) => [...canvas.getContext('2d').getImageData(x,y,1,1).data];
      assert.deepEqual(pixel(30,60), [255,255,255,255]);
      const inside = pixel(60,60);
      assert.ok(inside[0] > 190 && inside[1] < 150 && inside[2] < 150, `${format}/${i}: ${inside}`);
      if (format === 'png') assert.ok(inside[1] > 100, 'alpha blends with white rather than flattening to black');
      assert.deepEqual(pixel(125,60), [255,255,255,255]);
      assert.deepEqual(pixel(60,95), [255,255,255,255]);
    }
    await pdf.destroy();
    await assert.rejects(renderCpdCertificatePdf(source, fields), /Required signature image/);
    await assert.rejects(renderCpdCertificatePdf(source, fields, {}, { resolveImage: async () => ({ ...asset, bytes: Buffer.from('x') }) }), /integrity/);
  }
});

test('retained issued PDFs are authoritative without consulting replaced or removed signatures', async () => {
  const bytes = Buffer.from('retained certificate bytes');
  let reads = 0;
  const db = { from() { throw new Error('Must not load current template or images'); },
    storage: { from(bucket) { assert.equal(bucket, 'issued-cpd-certificates'); return {
      async download() { reads++; return { data: new Blob([bytes]) }; } }; } } };
  const output = await renderAttendeeCertificate(db, { issuedCertificate: { source_path: 'saved.pdf', pdf_sha256: signatureHash(bytes) } });
  assert.deepEqual(output, bytes);
  assert.equal(reads, 1);
});
