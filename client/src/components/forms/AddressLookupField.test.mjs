import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./AddressLookupField.jsx', import.meta.url), 'utf8');
const rendererSource = await readFile(new URL('./FormRenderer.jsx', import.meta.url), 'utf8');
const formViewSource = await readFile(new URL('../../pages/FormView.jsx', import.meta.url), 'utf8');
const embedFormSource = await readFile(new URL('../../pages/EmbedForm.jsx', import.meta.url), 'utf8');
const iEditFormSource = await readFile(new URL('../iedit/elements/IEditFormElement.jsx', import.meta.url), 'utf8');

test('address lookup is debounced and only starts for a normalized complete postcode', () => {
  assert.match(source, /normalizeUkPostcode\(postcode\)/);
  assert.match(source, /window\.setTimeout\(async \(\) => \{/);
  assert.match(source, /\}, 100\)/);
  assert.match(source, /resultsCache\.current\.get\(normalizedPostcode\)/);
});

test('a complete postcode shows accessible progress before the request delay', () => {
  const loadingStart = source.indexOf('setLoading(true)');
  const timerStart = source.indexOf('window.setTimeout(async');
  assert.ok(loadingStart >= 0 && loadingStart < timerStart);
  assert.match(source, /Finding addresses…/);
  assert.match(source, /role="status"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /aria-busy=\{loading\}/);
  assert.match(source, /Enter address manually instead/);
});

test('manual entry cancels a pending automatic lookup', () => {
  assert.match(source, /const enterManualAddress = \(\) =>/);
  assert.match(source, /requestGeneration\.current \+= 1/);
  assert.match(source, /abortRef\.current\?\.abort\(\)/);
  assert.match(source, /onClick=\{enterManualAddress\}/);
});

test('conditional manual-only mode suppresses lookup and cancels pending requests', () => {
  assert.match(source, /manualOnly = false/);
  assert.match(source, /disabled \|\| manualOnly \|\| !normalizedPostcode/);
  assert.match(source, /useEffect\(\(\) => \{\s*if \(!manualOnly\) return;/);
  assert.match(source, /\{!manualOnly && <div/);
  assert.match(source, /\(manualOnly \|\| manual \|\| Object\.values\(answer\)\.some\(Boolean\)\)/);
});

test('runtime resolves manual-only mode from live answers without changing the address value contract', () => {
  assert.match(rendererSource, /manualOnly=\{resolveAddressManualOnly\(field, allFields, allFormValues\)\}/);
  assert.doesNotMatch(source, /onChange\([^)]*manualOnly|onChange\([^)]*address_entry_mode_rule/);
  assert.match(source, /const answer = normalizeAddressLookupAnswer\(value\)/);
});

test('standalone, embedded, and Canvas forms pass live field metadata and answers to every layout', () => {
  assert.ok((formViewSource.match(/allFormValues=\{formValues\}/g) || []).length >= 2);
  assert.ok((formViewSource.match(/allFields=\{form\?\.fields \|\| \[\]\}/g) || []).length >= 2);
  assert.match(embedFormSource, /allFormValues=\{formValues\}/);
  assert.match(embedFormSource, /allFields=\{form\?\.fields \|\| \[\]\}/);
  assert.ok((iEditFormSource.match(/allFormValues=\{formValues\}/g) || []).length >= 2);
  assert.ok((iEditFormSource.match(/allFields=\{form\?\.fields \|\| \[\]\}/g) || []).length >= 2);
});

test('address lookup cancels stale requests and does not expose a search button', () => {
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /lookupError\?\.name === 'AbortError'/);
  assert.match(source, /requestGeneration\.current !== generation/);
  assert.match(source, /lookupError\.code === 'ADDRESS_LOOKUP_UNAVAILABLE'/);
  assert.doesNotMatch(source, /button-address-lookup-search|>Search</);
});

test('address suggestions expose accessible keyboard selection', () => {
  assert.match(source, /id=\{field\.id\}/);
  assert.match(source, /role="combobox"/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /role="option"/);
  assert.match(source, /event\.key === 'ArrowDown'/);
  assert.match(source, /event\.key === 'ArrowUp'/);
  assert.match(source, /event\.key === 'Enter'/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /onPointerDown=/);
  assert.match(source, /onPointerDown=\{event => \{\s*event\.preventDefault\(\)/);
  assert.match(source, /tabIndex=\{-1\}/);
  assert.match(source, /event\.currentTarget\.contains\(event\.relatedTarget\)/);
});

test('cached results can be reopened after dismissal without another provider request', () => {
  assert.match(source, /resultsCache\.current\.set\(normalizedPostcode, addresses\)/);
  assert.match(source, /const reopenCachedResults = \(\) =>/);
  assert.match(source, /onFocus=\{reopenCachedResults\}/);
});