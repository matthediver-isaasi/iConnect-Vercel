import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const renderer = readFileSync(
  new URL('../components/forms/FormRenderer.jsx', import.meta.url),
  'utf8',
);
const builder = readFileSync(new URL('../pages/FormBuilder.jsx', import.meta.url), 'utf8');

test('builder persists cards and spreadsheet repeatable-row layouts', () => {
  assert.match(builder, /data-testid=\{`select-repeatable-layout-\$\{field\.id\}`\}/);
  assert.match(builder, /<SelectItem value=\{REPEATABLE_ROW_LAYOUT_CARDS\}>Cards<\/SelectItem>/);
  assert.match(builder, /<SelectItem value=\{REPEATABLE_ROW_LAYOUT_SPREADSHEET\}>Spreadsheet<\/SelectItem>/);
  assert.match(builder, /updates\.layout = REPEATABLE_ROW_LAYOUT_CARDS/);
});

test('builder treats repeatable aliases as existing repeatable fields without resetting them', () => {
  assert.match(
    builder,
    /\(isRepeatableRowField\(field\) \? 'repeatable_rows' : field\.type\)/,
  );
  assert.match(
    builder,
    /value === 'repeatable_rows' && !isRepeatableRowField\(field\)/,
  );
  assert.match(
    builder,
    /field\.type === 'relationship_dropdown' \|\| isRepeatableRowField\(field\)/,
  );
});

test('spreadsheet repeatable rows render one header, aligned rows, and icon-only removal', () => {
  assert.match(renderer, /data-testid=\{`repeatable-spreadsheet-header-\$\{field\.id\}`\}/);
  assert.match(renderer, /gridTemplateColumns: `repeat\(\$\{config\.children\.length\}, minmax\(12rem, 1fr\)\) 2\.75rem`/);
  assert.match(renderer, /config\.children\.map\(child => renderChild\(child, row, rowId, rowIndex, true\)\)/);
  assert.match(renderer, /<Trash2 className="h-4 w-4" \/>/);
  assert.doesNotMatch(
    renderer.match(/\{spreadsheet \? \([\s\S]*?\) : rows\.map/)?.[0] || '',
    /aria-hidden="true">Row/,
  );
});

test('card mode retains row numbers and the existing remove action', () => {
  assert.match(renderer, /\) : rows\.map\(\(row, rowIndex\) => \{[\s\S]*?aria-hidden="true">Row \{rowIndex \+ 1\}<\/p>/);
  assert.match(renderer, /<X className="mr-1 h-4 w-4" \/> Remove/);
});