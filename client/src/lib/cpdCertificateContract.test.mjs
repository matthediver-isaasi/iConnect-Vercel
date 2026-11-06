import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  certificateDateRangeValues, certificateSampleValues, certificateTemplateEndpoints, formatCertificateValue,
  serializeCertificatePlaceholder, certificatePreviewValue,
  assertCertificateTextSaved, certificateSignaturePreviewUrl, validateCertificateSignatureFile,
} from './cpdCertificateContract.js';
import { readFileSync } from 'node:fs';
import { layoutPlaceholder } from '../../../api/_lib/cpdCertificatePdf.js';

test('historic title is a positioned field with an illustrative preview, not PDF text replacement', () => {
  const field = { key: 'historic_event_title', sample: 'Historical conference', page: 1,
    x: 10, y: 20, width: 300, height: 40, font_size: 12 };
  assert.equal(certificatePreviewValue(field), 'Historical conference');
  assert.deepEqual(certificateSampleValues([field]), { historic_event_title: 'Historical conference' });
  const serialized = serializeCertificatePlaceholder(field);
  assert.equal(serialized.placeholder_key, 'historic_event_title');
  assert.equal(serialized.page_number, 1);
  assert.equal(layoutPlaceholder(serialized, { historic_event_title: 'Actual imported title' }).value, 'Actual imported title');
});

test('points decoration agrees across preview and PDF, without changing raw samples', () => {
  const key = 'cpd.cpd_points';
  for (const [raw, format, expected] of [
    [8, null, '8 points'], [1, null, '1 points'], [0, null, '0 points'],
    [6.5, 'number:2', '6.50 points'], [12500.5, 'number', '12,500.5 points'],
    ['8 points', null, '8 points'], ['8 points', 'number:2', '8 points'],
  ]) {
    const field = { key, format, sample: raw };
    const placeholder = { placeholder_key: key, format, width: 300, height: 30, font_size: 12 };
    const browser = formatCertificateValue(raw, field);
    assert.equal(browser, expected);
    assert.equal(formatCertificateValue(browser, field), expected);
    assert.equal(layoutPlaceholder(placeholder, { [key]: raw }).value, expected);
    assert.equal(layoutPlaceholder(placeholder, { [key]: browser }).value, expected);
    assert.equal(certificateSampleValues([field])[key], raw);
  }
  for (const raw of [null, undefined, '']) {
    const field = { key, sample: raw, default_value: 0 };
    assert.equal(formatCertificateValue(certificatePreviewValue(field), field), '0 points');
    const base = { placeholder_key: key, width: 300, height: 30, font_size: 12 };
    assert.equal(layoutPlaceholder({ ...base, default_value: 0 }, { [key]: raw }).value, '0 points');
    assert.equal(layoutPlaceholder(base, { [key]: raw }).value, '');
    assert.equal(layoutPlaceholder({ ...base, missing_policy: 'literal' }, { [key]: raw }).value, `{{${key}}}`);
    assert.throws(() => layoutPlaceholder({ ...base, missing_policy: 'error' }, { [key]: raw }), /Missing value/);
  }
  assert.equal(formatCertificateValue(null, { key }), '');
  assert.equal(formatCertificateValue('', { key }), '');
  assert.equal(formatCertificateValue('', { key, format: 'number:2' }), '');
  assert.equal(layoutPlaceholder({ placeholder_key: key, default_value: '', format: 'number:2', width: 300, height: 30 }, {}).value, '');
  assert.equal(certificatePreviewValue({ sample: 0, default_value: 8 }), 0);
  for (const key of ['cpd.cpd_hours', 'custom.points']) {
    assert.equal(formatCertificateValue(8, { key }), '8');
    assert.equal(layoutPlaceholder({ placeholder_key: key, width: 300, height: 30 }, { [key]: 8 }).value, '8');
  }
});

test('placeholder serialization matches the certificate API contract', () => {
  const result = serializeCertificatePlaceholder({
    key: 'cpd.activity_date', page: 2, x: 10.5, y: 20, width: 100, height: 24,
    font_family: 'Helvetica', font_size: 14, font_style: 'italic', font_weight: 'bold',
    align: 'center', color: '#123456', multiline: false, shrink_to_fit: true,
    required: true, field_type: 'date', date_format: 'date:long', sample: '2026-02-28',
    minimum_font_size: 9, vertical_align: 'middle',
  });
  assert.deepEqual(result, {
    placeholder_key: 'cpd.activity_date', label: 'cpd.activity_date',
    field_type: 'date', sample_value: '2026-02-28', default_value: null, display_order: 0,
    multiline: false, shrink_to_fit: true,
    page_number: 2, x: 10.5, y: 20, width: 100, height: 24,
    font_family: 'Helvetica', font_size: 14, font_style: 'bolditalic', alignment: 'center',
    color: '#123456', line_height: 1.2, overflow_policy: 'shrink', missing_policy: 'error',
    format: 'date:long', minimum_font_size: 9, vertical_align: 'middle',
  });
});

test('render values are keyed separately from persisted placeholders', () => {
  assert.deepEqual(certificateSampleValues([{ key: 'member.full_name', sample: 'A. Member' }, { key: 'cpd.points', sample: '' }]), {
    'member.full_name': 'A. Member', 'cpd.points': '',
  });
});

test('certificate start and end placeholders are independent, including a single-day activity', () => {
  const values = certificateDateRangeValues({ start_date: '2026-03-28', end_date: '2026-03-30' });
  assert.equal(values['cpd.activity_start_date'], '2026-03-28');
  assert.equal(values['cpd.activity_end_date'], '2026-03-30');
  assert.equal(values['cpd.activity_date'], '28 March 2026');
  assert.equal(values['cpd.activity_date_range'], '28 March 2026 – 30 March 2026');
  assert.equal(certificateDateRangeValues({ start_date: '2026-03-28', end_date: null })['cpd.activity_end_date'], '');
  assert.equal(certificateDateRangeValues({ start_date: '2026-03-28', end_date: null })['cpd.activity_date_range'], '28 March 2026');
});

test('browser preview applies the same date and number formats as PDF generation', () => {
  assert.equal(formatCertificateValue('2026-08-28T00:00:00.000Z', {
    field_type: 'date', date_format: 'DD/MM/YYYY',
  }), '28/08/2026');
  assert.equal(formatCertificateValue(12500.5, {
    field_type: 'number', number_format: 'number',
  }), '12,500.5');
});

test('database definitions allow one data key in multiple placeholder positions', () => {
  const migration = readFileSync('supabase/migrations/20260906_cpd_certificate_templates.sql', 'utf8');
  const schema = readFileSync('shared/schema.ts', 'utf8');
  assert.doesNotMatch(migration, /UNIQUE\s*\(\s*template_id\s*,\s*placeholder_key\s*\)/i);
  assert.doesNotMatch(schema, /uniqueIndex\(["']cpd_certificate_placeholder_template_key/);
});

test('role exclusions are seeded with native text-array operations', () => {
  const migration = readFileSync('supabase/migrations/20260906_cpd_certificate_templates.sql', 'utf8');
  const roleSeed = migration.slice(migration.indexOf('UPDATE role'));
  assert.match(roleSeed, /COALESCE\(excluded_features,\s*ARRAY\[\]::TEXT\[\]\)/);
  assert.match(roleSeed, /ARRAY\['cpd',\s*'cpd\.certificate-templates'\]::TEXT\[\]/);
  assert.match(roleSeed, /@>\s*ARRAY\['cpd',\s*'cpd\.certificate-templates'\]::TEXT\[\]/);
  assert.doesNotMatch(roleSeed, /jsonb/i);
});

test('request endpoints use source, lifecycle, and render API routes', () => {
  assert.deepEqual(certificateTemplateEndpoints('a/b'), {
    item: '/api/cpd-certificate-templates/a%2Fb',
    source: '/api/cpd-certificate-templates/a%2Fb/source',
    duplicate: '/api/cpd-certificate-templates/a%2Fb/duplicate',
    lifecycle: '/api/cpd-certificate-templates/a%2Fb/lifecycle',
    preview: '/api/cpd-certificate-templates/a%2Fb/preview',
    render: '/api/cpd-certificate-templates/a%2Fb/render',
    signatures: '/api/cpd-certificate-templates/a%2Fb/signatures',
  });
});

test('designer guards the initial null draft before reading status', () => {
  const designer = readFileSync('client/src/pages/CPDCertificateTemplates.jsx', 'utf8');
  const loadingGuard = designer.indexOf('if (isLoading || !draft)');
  const statusRead = designer.indexOf("const isActive = draft.status === 'active'");

  assert.notEqual(loadingGuard, -1);
  assert.notEqual(statusRead, -1);
  assert.ok(loadingGuard < statusRead, 'the null-draft loading guard must run before draft.status is read');
  assert.match(designer, /\{error \? error\.message : 'Loading designer…'\}/);
});

test('designer keeps editing controls hidden for active templates', () => {
  const designer = readFileSync('client/src/pages/CPDCertificateTemplates.jsx', 'utf8');

  assert.match(designer, /\{!isActive && <><Button[^>]+>.*Replace PDF/s);
  assert.match(designer, /\{!isActive && <Button variant="outline" onClick=\{\(\) => setPreview\(v => !v\)\}>\{preview \? 'Edit' : 'Preview'\}<\/Button>\}/);
  assert.match(designer, /\{!isActive && <Button onClick=\{save\}/);
  assert.match(designer, /\{!preview && !isActive && <aside/);
});

const signatureField = {
  key: 'signature.chair', field_type: 'image',
  image_asset_id: '12345678-1234-4234-8234-123456789abc', image_sha256: 'a'.repeat(64),
  page: 2, x: 31, y: 42, width: 180, height: 60,
  image_width: 900, image_height: 300, image_preview_url: '/private-preview',
  font_family: 'Helvetica', font_size: 18, font_style: 'normal', align: 'left', color: '#111827',
};

test('signatures persist identity and geometry with legacy RPC attributes but no browser metadata or sample dependency', () => {
  const saved = serializeCertificatePlaceholder({
    ...signatureField, sample: 'not certificate data', default_value: 'not a fallback',
    text_template: '{{unsupported_image_token}}',
  });
  assert.equal(saved.field_type, 'image');
  assert.equal(saved.image_asset_id, signatureField.image_asset_id);
  assert.equal(saved.image_sha256, signatureField.image_sha256);
  assert.equal(saved.page_number, 2);
  for (const key of ['x', 'y', 'width', 'height', 'font_family', 'font_size', 'font_style', 'color']) {
    assert.equal(saved[key], signatureField[key]);
  }
  assert.equal(saved.sample_value, '');
  assert.equal(saved.default_value, null);
  for (const key of ['text_template', 'image_width', 'image_height', 'image_preview_url']) assert.equal(key in saved, false);
  assert.deepEqual(certificateSampleValues([signatureField]), {});
  assert.equal(certificatePreviewValue(signatureField, { 'signature.chair': 'ignored' }), null);
  assert.equal(certificateSignaturePreviewUrl('a/b', signatureField.image_asset_id),
    `/api/cpd-certificate-templates/a%2Fb/signatures?assetId=${signatureField.image_asset_id}`);
});

test('checked save rejects dropped/changed image identity, page and every geometry coordinate, including duplicate fields', () => {
  const expected = serializeCertificatePlaceholder(signatureField);
  assert.doesNotThrow(() => assertCertificateTextSaved([expected], [{ ...expected, width: '180' }]));
  assert.throws(() => assertCertificateTextSaved([expected], []), /draft has been kept/);
  for (const [key, value] of Object.entries({
    field_type: 'text', image_asset_id: '87654321-1234-4234-8234-123456789abc',
    image_sha256: 'b'.repeat(64), page_number: 1, x: 32, y: 43, width: 181, height: 61,
  })) {
    assert.throws(() => assertCertificateTextSaved([expected], [{ ...expected, [key]: value }]), /draft has been kept/, key);
  }
  const duplicate = { ...expected, x: 41 };
  assert.doesNotThrow(() => assertCertificateTextSaved([expected, duplicate], [duplicate, expected]));
  assert.throws(() => assertCertificateTextSaved([expected, duplicate], [expected, expected]), /draft has been kept/);
  const text = { placeholder_key: 'text.body', text_template: 'Verified text' };
  assert.throws(() => assertCertificateTextSaved([expected, text], [expected, { ...text, text_template: null }]), /draft has been kept/);
});

test('signature upload accepts JPG/JPEG/PNG up to exactly 2 MiB and rejects empty, oversized or unsupported files', () => {
  for (const name of ['signature.jpg', 'signature.JPEG', 'signature.png']) {
    assert.doesNotThrow(() => validateCertificateSignatureFile({
      name, type: name.endsWith('png') ? 'image/png' : 'image/jpeg', size: 2 * 1024 * 1024,
    }));
  }
  for (const file of [null, { name: 'x.svg', type: 'image/svg+xml', size: 50 },
    { name: 'x.gif', type: 'image/png', size: 50 }, { name: 'x.jpg', type: 'application/pdf', size: 50 },
    { name: 'x.png', type: 'image/png', size: 0 }, { name: 'x.png', type: 'image/png', size: 2 * 1024 * 1024 + 1 }]) {
    assert.throws(() => validateCertificateSignatureFile(file));
  }
  for (const patch of [{ image_asset_id: null }, { image_sha256: 'invalid' }]) {
    assert.throws(() => serializeCertificatePlaceholder({ ...signatureField, ...patch }), /valid signature/);
  }
});
