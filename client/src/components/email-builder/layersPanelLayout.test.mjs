import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('./LayersPanel.jsx', import.meta.url),
  'utf8',
);

test('sortable layer rows constrain long labels while reserving action width', () => {
  assert.match(
    source,
    /itemClassName = 'flex w-full min-w-0 items-center[^']*overflow-hidden/,
    'top-level and nested sortable rows must not grow wider than the Layers panel',
  );
  assert.match(
    source,
    /<span className="min-w-0 flex-1 truncate text-\[13px\]">\{getBlockLabel\(item\.block\)\}<\/span>/,
    'sortable labels must yield horizontal space and truncate',
  );
  assert.match(
    source,
    /<div className="ml-auto flex flex-shrink-0 items-center gap-0\.5" style=\{\{ visibility: 'visible' \}\}>/,
    'visibility, duplicate, and delete controls must retain their width',
  );
});

test('column-child rows constrain long labels without losing delete controls', () => {
  assert.match(
    source,
    /<span className="min-w-0 flex-1 truncate text-\[13px\]">\{getBlockLabel\(child\)\}<\/span>/,
    'column-child labels must shrink inside their indented row',
  );
  assert.match(
    source,
    /<div className="ml-auto flex flex-shrink-0 items-center gap-0\.5">\s*<button[\s\S]*?layer-col-child-delete-/,
    'column-child delete controls must retain their width',
  );
  assert.match(
    source,
    /<div key=\{col\.id\} className="min-w-0">/,
    'nested column containers must allow their descendants to shrink',
  );
});