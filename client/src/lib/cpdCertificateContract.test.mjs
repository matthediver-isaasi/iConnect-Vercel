import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  certificateSampleValues, certificateTemplateEndpoints, formatCertificateValue,
  serializeCertificatePlaceholder,
} from './cpdCertificateContract.js';
import { readFileSync } from 'node:fs';

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