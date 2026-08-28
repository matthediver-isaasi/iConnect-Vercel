import test from 'node:test';
import assert from 'node:assert/strict';
import { degrees, PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { inspectPdf, layoutPlaceholder, renderCpdCertificatePdf, visualToPdfPoint } from './cpdCertificatePdf.js';

async function compressedPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([600, 800]);
  doc.addPage([400, 300]);
  // pdf-lib object streams exercise the exact xref/object-stream case that
  // the old regex parser could not inspect.
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

test('inspectPdf accepts object-stream PDFs and reports every page', async () => {
  const source = await compressedPdf();
  const inspected = await inspectPdf(source);
  assert.equal(inspected.pages.length, 2);
  assert.deepEqual(inspected.geometry[1], {
    width: 400, height: 300, raw_width: 400, raw_height: 300,
    raw_x: 0, raw_y: 0, rotation: 0,
  });
  await assert.rejects(inspectPdf(Buffer.from('not pdf')), /signature/);
  await assert.rejects(inspectPdf(Buffer.alloc(0)), /empty/);
  await assert.rejects(inspectPdf(source, { mimeType: 'text/plain' }), /MIME/);
  await assert.rejects(inspectPdf(source, { maxBytes: source.length - 1 }), /exceeds/);
});

test('layout supports wrapping, requested minimum font and missing policy', () => {
  const base = {
    placeholder_key: 'name', width: 40, height: 100, font_size: 12, minimum_font_size: 8,
    font_family: 'Helvetica', overflow_policy: 'shrink', multiline: true, shrink_to_fit: true, line_height: 1.2,
  };
  const layout = layoutPlaceholder(base, { name: 'a long certificate recipient name' });
  assert.ok(layout.lines.length > 1);
  assert.ok(layout.size >= 8);
  assert.throws(() => layoutPlaceholder({ ...base, font_family: 'Comic Sans' }, { name: 'x' }), /Unsupported font/);
  assert.throws(() => layoutPlaceholder({ ...base, missing_policy: 'error' }, {}), /Missing value/);
});

test('layout never silently overflows unbroken text or exhausted minimum height', () => {
  const oneLine = layoutPlaceholder({
    placeholder_key: 'code', width: 40, height: 20, font_size: 12, minimum_font_size: 8,
    font_family: 'Helvetica', multiline: false, shrink_to_fit: true, line_height: 1,
  }, { code: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
  assert.equal(oneLine.lines.length, 1);
  assert.ok(oneLine.lines[0].length < 26);
  assert.throws(() => layoutPlaceholder({
    placeholder_key: 'tiny', width: 40, height: 3, font_size: 12, minimum_font_size: 8,
    font_family: 'Helvetica', multiline: false, shrink_to_fit: true, line_height: 1,
  }, { tiny: 'x' }), /too short/);
});

test('date and number token formats are applied to normal values', () => {
  const date = layoutPlaceholder({
    placeholder_key: 'date', width: 300, height: 30, font_size: 12,
    font_family: 'Helvetica', format: 'DD/MM/YYYY',
  }, { date: '2026-08-28T00:00:00.000Z' });
  assert.equal(date.lines[0], '28/08/2026');
  const number = layoutPlaceholder({
    placeholder_key: 'points', width: 300, height: 30, font_size: 12,
    font_family: 'Helvetica', format: '0.##',
  }, { points: 6.5 });
  assert.equal(number.lines[0], '6.5');
  const genericNumber = layoutPlaceholder({
    placeholder_key: 'points', width: 300, height: 30, font_size: 12,
    font_family: 'Helvetica', format: 'number',
  }, { points: 12_500.5 });
  assert.equal(genericNumber.lines[0], '12,500.5');
});

test('all page rotations preserve visual placeholder position and horizontal orientation', async () => {
  for (const rotation of [0, 90, 180, 270]) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    page.setCropBox(20, 30, 500, 700);
    page.setRotation(degrees(rotation));
    const source = Buffer.from(await doc.save());
    const inspected = await inspectPdf(source);
    const swap = rotation === 90 || rotation === 270;
    assert.deepEqual(inspected.geometry[0], {
      width: swap ? 700 : 500,
      height: swap ? 500 : 700,
      raw_width: 500,
      raw_height: 700,
      raw_x: 20,
      raw_y: 30,
      rotation,
    });

    const output = await renderCpdCertificatePdf(source, [{
      placeholder_key: 'marker', page_number: 1, x: 50, y: 60, width: 200, height: 40,
      font_family: 'Helvetica', font_style: 'normal', font_size: 20, minimum_font_size: 10,
      alignment: 'left', vertical_align: 'top', color: '#000000', line_height: 1,
      multiline: false, shrink_to_fit: true,
    }], { marker: 'ROTATION_TEST' });

    // PDF.js uses the exact viewport used by the browser designer. Compose
    // that with the emitted text matrix and assert a visual baseline at
    // (50,80), horizontal to the right with glyphs extending upward.
    const rendered = await pdfjs.getDocument({
      data: new Uint8Array(output),
      disableWorker: true,
    }).promise;
    const renderedPage = await rendered.getPage(1);
    const viewport = renderedPage.getViewport({ scale: 1 });
    const text = await renderedPage.getTextContent();
    const item = text.items.find((entry) => entry.str === 'ROTATION_TEST');
    assert.ok(item, `rotation ${rotation} should contain flattened text`);
    const matrix = pdfjs.Util.transform(viewport.transform, item.transform);
    const expected = [20, 0, 0, -20, 50, 80];
    matrix.forEach((value, index) => {
      assert.ok(Math.abs(value - expected[index]) < 0.001,
        `rotation ${rotation} matrix[${index}] expected ${expected[index]}, got ${value}`);
    });
  }
});

test('renderer overlays controlled fonts on multiple pages and keeps output parseable', async () => {
  const rendered = await renderCpdCertificatePdf(await compressedPdf(), [
    { placeholder_key: 'name', page_number: 1, x: 20, y: 20, width: 300, height: 50,
      font_family: 'Times', font_style: 'bold', font_size: 20, minimum_font_size: 8,
      alignment: 'center', vertical_alignment: 'middle', color: '#112233', line_height: 1.2, overflow_policy: 'shrink', missing_policy: 'error' },
    { placeholder_key: 'hours', page_number: 2, x: 10, y: 10, width: 150, height: 30,
      font_family: 'Courier', font_style: 'normal', font_size: 12, alignment: 'left',
      vertical_alignment: 'bottom', color: '#000000', line_height: 1.2, overflow_policy: 'wrap', missing_policy: 'error', format: 'number' },
  ], { name: 'Ada Lovelace', hours: 12_500 });
  const inspected = await inspectPdf(rendered);
  assert.equal(inspected.pages.length, 2);
  assert.ok(rendered.length > 100);
});