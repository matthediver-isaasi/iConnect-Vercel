import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { CPD_TEXT_EXAMPLE, validateCertificateText } from '../../shared/cpdCertificateDisplay.js';
import { serializeCertificatePlaceholder, certificatePreviewValue, certificateSampleValues } from '../../client/src/lib/cpdCertificateContract.js';
import { validPlaceholders } from './cpdCertificateTemplatesApi.js';
import { layoutPlaceholder, renderCpdCertificatePdf } from './cpdCertificatePdf.js';
import { realCertificatePlaceholders } from './attendeeCpdCertificate.js';
import { resolveHistoricCertificate } from './historicCpdCertificate.js';
import { prepareManualCertificate } from './manualCpdAwards.js';

const field = { key: 'text.credits', label: 'Credits', text_template: CPD_TEXT_EXAMPLE,
  page: 1, x: 20, y: 20, width: 500, height: 120, font_family: 'Helvetica',
  font_size: 18, minimum_font_size: 8, align: 'left', required: true, multiline: true };
const placeholder = validPlaceholders([serializeCertificatePlaceholder(field)])[0];
const expected = value => CPD_TEXT_EXAMPLE.replace('{{number_of_cpd_points}}', String(value));
test('API save/load/duplicate projection retains authored text independently of samples', () => {
  const stored = JSON.parse(JSON.stringify(placeholder));
  assert.equal(validPlaceholders([stored])[0].text_template, CPD_TEXT_EXAMPLE);
  const loaded = { ...stored, key: stored.placeholder_key, page: stored.page_number, sample: stored.sample_value };
  assert.equal(serializeCertificatePlaceholder(loaded).text_template, CPD_TEXT_EXAMPLE);
  assert.deepEqual(certificateSampleValues([field], 6.5), { 'cpd.cpd_points': 6.5 });
  for (const text of ['{{unknown}}', '{{number_of_cpd_points}', '{{}}', '{{member.full_name}}']) {
    assert.throws(() => validPlaceholders([{ ...placeholder, text_template: text }]), /Unsupported certificate token/);
    assert.throws(() => serializeCertificatePlaceholder({ ...field, text_template: text }), /Unsupported certificate token/);
  }
  assert.throws(() => validateCertificateText(42), /Certificate text/);
});
test('browser and PDF share numeric substitution; missing evidence never uses samples/defaults', () => {
  for (const raw of [8, 6.5, 0, '2.25']) {
    const values = { 'cpd.cpd_points': raw };
    assert.equal(certificatePreviewValue(field, values), expected(raw));
    assert.equal(layoutPlaceholder(placeholder, values).value, expected(raw));
    assert.deepEqual(realCertificatePlaceholders([placeholder], values).missing, []);
  }
  for (const raw of [undefined, null, '', ' ', false, NaN, Infinity, '8 points']) {
    const values = { 'cpd.cpd_points': raw };
    const p = { ...placeholder, sample_value: '999', default_value: '999' };
    assert.deepEqual(realCertificatePlaceholders([p], values).missing, ['cpd.cpd_points']);
    assert.throws(() => layoutPlaceholder(p, values), /Missing value/);
    assert.equal(layoutPlaceholder({ ...p, missing_policy: 'literal' }, values).value, '');
  }
  assert.equal(layoutPlaceholder({ ...placeholder, text_template: 'Attendance certificate' }, {}).value, 'Attendance certificate');
});
test('PDF extraction preserves exact flowing sentence at wide and narrow widths', async () => {
  const doc = await PDFDocument.create(); doc.addPage([600, 800]);
  const bytes = await doc.save();
  for (const width of [500, 220]) {
    for (const points of [8, 6.5, 0]) {
      const output = await renderCpdCertificatePdf(bytes, [{ ...placeholder, width, height: 180 }], { 'cpd.cpd_points': points });
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(output), disableWorker: true }).promise;
      const text = await (await pdf.getPage(1)).getTextContent();
      assert.equal(text.items.map(i => i.str).filter(Boolean).join(' ').replace(/\s+/g, ' '), expected(points));
      assert.ok(new Set(text.items.filter(i => i.str).map(i => i.transform[5])).size > 1);
      await pdf.destroy();
    }
  }
});

test('historic and manual issuance resolve inline-only points from their existing evidence', async () => {
  const doc = await PDFDocument.create(); doc.addPage([600, 800]);
  const bytes = Buffer.from(await doc.save());
  const template = { id: 'template', tenant_id: 'tenant', status: 'active',
    source_bucket: 'private-uploads', source_path: 'tenant/source.pdf',
    source_sha256: createHash('sha256').update(bytes).digest('hex') };
  const member = { id: 'member', tenant_id: 'tenant', first_name: 'Fixture', last_name: 'Member' };
  const rows = { historic_cpd_certificate: [{ tenant_id: 'tenant', template_id: 'template' }],
    cpd_certificate_template: [template], member: [member],
    cpd_certificate_placeholder: [
      { ...placeholder, tenant_id: 'tenant', template_id: 'template', sample_value: '999', default_value: '999' },
      { ...placeholder, tenant_id: 'tenant', template_id: 'template', text_template: null, placeholder_key: 'cpd.activity_title', y: 220 },
    ] };
  const db = { from(table) {
    let single = false; const filters = [];
    const q = { select: () => q, order: () => q, eq(k, v) { filters.push(r => r[k] === v); return q; },
      maybeSingle() { single = true; return q; },
      then(resolve, reject) { const data = rows[table].filter(r => filters.every(f => f(r)));
        return Promise.resolve({ data: single ? data[0] : data }).then(resolve, reject); } };
    return q;
  }, storage: { from: () => ({ download: async () => ({ data: new Blob([bytes]) }) }) } };
  for (const points of [8, 2.5, 0]) {
    const row = { id: 'award', activity_title: 'Real activity', activity_date: '2026-10-27', points_value: points };
    const historic = await resolveHistoricCertificate(db, { tenantId: 'tenant', memberCertificateId: 'member', row });
    assert.equal(historic.available, true);
    assert.equal(layoutPlaceholder(historic.placeholders[0], historic.values).value, expected(points));
    const manual = await prepareManualCertificate(db, 'tenant', member, { ...row, template_id: 'template' });
    assert.equal(manual.values['cpd.cpd_points'], points);
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(manual.pdf), disableWorker: true }).promise;
    const text = await (await pdf.getPage(1)).getTextContent();
    assert.ok(text.items.map(i => i.str).filter(Boolean).join(' ').includes(expected(points)));
    await pdf.destroy();
  }
  assert.equal((await resolveHistoricCertificate(db, { tenantId: 'tenant', memberCertificateId: 'member',
    row: { activity_title: 'Real activity', points_value: null } })).available, false);
});
