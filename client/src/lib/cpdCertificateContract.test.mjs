import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  certificateDateRangeValues, certificateSampleValues, certificateTemplateEndpoints, formatCertificateValue,
  serializeCertificatePlaceholder, certificatePreviewValue,
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
