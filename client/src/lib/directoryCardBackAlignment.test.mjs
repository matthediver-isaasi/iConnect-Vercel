import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const directoryView = readFileSync(
  new URL('../pages/DynamicDirectoryView.jsx', import.meta.url),
  'utf8',
);
const directoryCards = readFileSync(
  new URL('../components/directory/DirectoryCards.jsx', import.meta.url),
  'utf8',
);

test('organisation card-back custom fields use left-aligned wrapping values', () => {
  const start = directoryView.indexOf('const renderOrgCustomField = (field) =>');
  const end = directoryView.indexOf("} else if (key.startsWith('custom:'))", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const renderer = directoryView.slice(start, end);
  assert.match(renderer, /grid-cols-\[minmax\(0,1fr\)_minmax\(0,2fr\)\]/);
  assert.match(renderer, /text-slate-900 text-left break-words/);
  assert.doesNotMatch(renderer, /text-right/);
});

test('compact front-card field alignment remains unchanged', () => {
  assert.match(
    directoryCards,
    /text-xs font-medium text-slate-700 text-right truncate max-w-\[50%\]/,
  );
});