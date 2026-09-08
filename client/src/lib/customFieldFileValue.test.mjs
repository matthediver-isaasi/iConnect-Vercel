import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCustomFieldFileSize,
  normalizeCustomFieldFileValue,
} from './customFieldFileValue.mjs';

test('normalizes object and serialized custom file metadata', () => {
  const objectResult = normalizeCustomFieldFileValue({
    file_url: 'https://files.example.test/report.pdf',
    file_name: 'Annual report.pdf',
    file_size: 1536,
  });
  const stringResult = normalizeCustomFieldFileValue(JSON.stringify({
    file_url: 'https://files.example.test/report.pdf',
    file_name: 'Annual report.pdf',
    file_size: 1536,
  }));

  assert.deepEqual(stringResult, objectResult);
  assert.equal(objectResult.status, 'ready');
  assert.equal(objectResult.file.file_name, 'Annual report.pdf');
  assert.equal(objectResult.file.file_size, 1536);
  assert.equal(formatCustomFieldFileSize(objectResult.file.file_size), '1.5 KB');
});

test('keeps legacy URL-only values usable and derives a human-readable filename', () => {
  const result = normalizeCustomFieldFileValue('https://files.example.test/uploads/Board%20minutes.docx?version=2');

  assert.equal(result.status, 'ready');
  assert.equal(result.file.file_name, 'Board minutes.docx');
  assert.equal(result.file.file_url, 'https://files.example.test/uploads/Board%20minutes.docx?version=2');
});

test('builds an authenticated secure reference for private storage metadata', () => {
  const result = normalizeCustomFieldFileValue({
    storage_path: 'tenant-1/private/report.pdf',
    bucket: 'private-uploads',
    file_name: 'report.pdf',
    is_private: true,
  });

  assert.equal(result.status, 'ready');
  assert.equal(
    result.file.file_url,
    '/api/storage/secure-url?bucket=private-uploads&path=tenant-1%2Fprivate%2Freport.pdf',
  );
});

test('distinguishes empty values from malformed or incomplete metadata', () => {
  assert.equal(normalizeCustomFieldFileValue('').status, 'empty');
  assert.equal(normalizeCustomFieldFileValue(null).status, 'empty');
  assert.equal(normalizeCustomFieldFileValue('{not-json').status, 'unavailable');
  assert.equal(normalizeCustomFieldFileValue({ file_name: 'missing.pdf' }).status, 'unavailable');
  assert.equal(normalizeCustomFieldFileValue(['https://files.example.test/a.pdf']).status, 'unavailable');
});

test('rejects unsafe file URL schemes', () => {
  assert.equal(normalizeCustomFieldFileValue('javascript:alert(1)').status, 'unavailable');
  assert.equal(normalizeCustomFieldFileValue('data:text/html,unsafe').status, 'unavailable');
  assert.equal(normalizeCustomFieldFileValue('//evil.example.test/file.pdf').status, 'unavailable');
});