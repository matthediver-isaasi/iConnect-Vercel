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

test('builder exposes per-column uniqueness and renderer shows duplicate feedback', () => {
  assert.match(
    builder,
    /data-testid=\{`switch-repeatable-child-unique-\$\{child\.id\}`\}/,
  );
  assert.match(builder, /Unique across rows/);
  assert.match(
    renderer,
    /error\.code === 'duplicate_child_value'/,
  );
  assert.match(
    renderer,
    /data-testid=\{`repeatable-duplicate-error-\$\{field\.id\}-\$\{rowIndex\}-\$\{child\.id\}`\}/,
  );
  assert.match(renderer, /That value is already used in another row\./);
  assert.doesNotMatch(renderer, /className="text-xs text-red-600"[\s\S]*?repeatable-duplicate-error/);
  assert.doesNotMatch(renderer, /role="alert"[\s\S]*?repeatable-duplicate-error/);
});

test('unique repeatable dropdowns receive sibling exclusions across option sources', () => {
  assert.match(renderer, /repeatableSiblingUniqueValues\(rows, child, rowId\)/);
  assert.match(renderer, /repeatableSiblingUniqueValues=\{siblingUniqueValues\}/);
  assert.match(renderer, /const effectiveStaticOptions = staticOptions\.filter\(repeatableOptionIsAvailable\)/);
  assert.match(renderer, /const effectiveOrganisationOptions = organisationOptions\.filter\(/);
  assert.match(renderer, /const effectiveOrganisationGroupOptions = organisationGroupOptions\.filter\(/);
  assert.match(renderer, /relationshipOptions\.filter\(/);
  assert.match(renderer, /relationshipResultIsEmpty = isConfirmedEmptyRelationshipResult\(\{[\s\S]*?options: rawRelationshipOptions/);
  assert.match(renderer, /All available choices are already used in another row/);
  assert.match(renderer, /repeatableOptionIsAvailable\(country\.name\)/);
  assert.match(renderer, /repeatableOptionIsAvailable\(option\?\.value \|\| option\)/);
  assert.match(renderer, /const effectiveCustomFieldOptions = customFieldOptions\.filter/);
  assert.match(renderer, /isSelectionAllowed=\{repeatableSelectionIsAvailable\}/);
  assert.match(renderer, /const allowedCountriesSingle = customCountryOptions\.filter/);
  assert.match(renderer, /disabled=\{!canToggleCountry\(country\)\}/);
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