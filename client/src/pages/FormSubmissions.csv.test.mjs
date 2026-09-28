import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatRepeatableRowsText } from '../../../shared/repeatableFormRowsFormat.js';

test('CSV field formatting regression: ordinary field and repeatable field execute without an undeclared fieldType', () => {
  // Execute the same discriminator used by the CSV default branch. This
  // specifically catches the previous ReferenceError before ordinary fields
  // could be exported.
  const format = (fieldDef, value) => {
    const fieldType = fieldDef?.type;
    if (fieldType === 'text') return String(value);
    if (fieldType === 'repeatable_row') return formatRepeatableRowsText(fieldDef, value);
    return String(value);
  };
  assert.equal(format({ type: 'text' }, 'ordinary response'), 'ordinary response');
  assert.match(format({
    type: 'repeatable_row',
    repeatable_row: { child_fields: [{ id: 'name', label: 'Name', type: 'text' }] },
  }, [{ _row_id: 'row-1', name: 'Repeated response' }]), /Name: Repeated response/);

  const source = readFileSync(new URL('./FormSubmissions.jsx', import.meta.url), 'utf8');
  assert.match(source, /const fieldType = fieldDef\?\.type;\s*if \(val == null\)/);
});

test('CSV repeatable date formatting keeps month/year answers partial', () => {
  const field = {
    type: 'repeatable_rows',
    children: [
      { id: 'month', label: 'Month', type: 'date', date_precision: 'month' },
      { id: 'year', label: 'Year', type: 'date', date_precision: 'year' },
    ],
  };
  assert.equal(
    formatRepeatableRowsText(field, [{ month: '2026-03', year: '2026' }]),
    'Row 1\nMonth: 2026-03\nYear: 2026',
  );
});

test('CSV repeatable upload labels display filenames without serialized metadata', () => {
  const field = {
    type: 'repeatable_rows',
    children: [{ id: 'upload', label: 'Document', type: 'file' }],
  };
  const file = {
    file_name: 'proof.pdf', file_url: '/api/storage/secure-url?bucket=private-uploads&path=tenant%2Fproof.pdf',
    bucket: 'private-uploads', storage_path: 'tenant/proof.pdf', is_private: true,
  };
  const result = formatRepeatableRowsText(field, [{ upload: JSON.stringify(file) }, { upload: file }]);
  assert.equal(result, 'Row 1\nDocument: proof.pdf\n\nRow 2\nDocument: proof.pdf');
  assert.doesNotMatch(result, /file_url|storage_path|\\[object Object\\]/);
});