// Tests for the per-filter condition-operator plumbing shared by the admin
// members/organisations paginated endpoints and the org CSV export:
//   - normalizeCustomFilterEntry: legacy encodings + operator objects
//   - prefEntryNeedsAntiJoin: negative ops execute as anti-joins
//   - applyPrefFilterEntry: embed-level conditions per op
//   - parseCoreFilters / applyDirectColumnFilter: direct-column operators
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCustomFilterEntry,
  prefEntryNeedsAntiJoin,
  applyPrefFilterEntry,
  parseCoreFilters,
  applyDirectColumnFilter,
  quoteForOr,
  escapeIlikeWildcards,
} from './prefValueOptionFilter.js';

// Minimal query stub that records chained calls so tests can assert on the
// exact PostgREST conditions each entry produces.
function makeQueryStub() {
  const calls = [];
  const stub = {};
  for (const m of ['eq', 'neq', 'or', 'ilike', 'is', 'not']) {
    stub[m] = (...args) => {
      calls.push([m, ...args]);
      return stub;
    };
  }
  stub.calls = calls;
  return stub;
}

// ---------------------------------------------------------------------------
// normalizeCustomFilterEntry — legacy encodings keep their default operators
// ---------------------------------------------------------------------------

test('normalize: legacy array is any_of option', () => {
  assert.deepEqual(normalizeCustomFilterEntry(['A', 'B']), {
    op: 'any_of', kind: 'option', values: ['A', 'B'],
  });
});

test('normalize: legacy array drops empty and "all" values', () => {
  assert.deepEqual(normalizeCustomFilterEntry(['', 'all', 'C']), {
    op: 'any_of', kind: 'option', values: ['C'],
  });
  assert.equal(normalizeCustomFilterEntry(['', 'all']), null);
});

test('normalize: legacy __text__ prefix is contains', () => {
  assert.deepEqual(normalizeCustomFilterEntry('__text__:hello'), {
    op: 'contains', kind: 'text', value: 'hello',
  });
  assert.equal(normalizeCustomFilterEntry('__text__:'), null);
});

test('normalize: legacy __bool__ prefix is bool_is (Yes/No only)', () => {
  assert.deepEqual(normalizeCustomFilterEntry('__bool__:Yes'), {
    op: 'bool_is', kind: 'bool', value: 'Yes',
  });
  assert.deepEqual(normalizeCustomFilterEntry('__bool__:No'), {
    op: 'bool_is', kind: 'bool', value: 'No',
  });
  assert.equal(normalizeCustomFilterEntry('__bool__:Maybe'), null);
});

test('normalize: legacy __country__ prefix is any_of country', () => {
  assert.deepEqual(normalizeCustomFilterEntry('__country__:France'), {
    op: 'any_of', kind: 'country', values: ['France'],
  });
  assert.equal(normalizeCustomFilterEntry('__country__:'), null);
});

test('normalize: bare legacy string is single-value any_of option', () => {
  assert.deepEqual(normalizeCustomFilterEntry('Gold'), {
    op: 'any_of', kind: 'option', values: ['Gold'],
  });
});

test('normalize: empty-ish raw values are null', () => {
  assert.equal(normalizeCustomFilterEntry(undefined), null);
  assert.equal(normalizeCustomFilterEntry(null), null);
  assert.equal(normalizeCustomFilterEntry(''), null);
  assert.equal(normalizeCustomFilterEntry('all'), null);
});

// ---------------------------------------------------------------------------
// normalizeCustomFilterEntry — operator objects
// ---------------------------------------------------------------------------

test('normalize: emptiness operator objects need no value', () => {
  assert.deepEqual(normalizeCustomFilterEntry({ op: 'empty' }), { op: 'empty', kind: 'any' });
  assert.deepEqual(normalizeCustomFilterEntry({ op: 'not_empty' }), { op: 'not_empty', kind: 'any' });
});

test('normalize: none_of with array of options', () => {
  assert.deepEqual(normalizeCustomFilterEntry({ op: 'none_of', value: ['A', 'all', ''] }), {
    op: 'none_of', kind: 'option', values: ['A'],
  });
  assert.equal(normalizeCustomFilterEntry({ op: 'none_of', value: [] }), null);
});

test('normalize: none_of country keeps the __country__ prefix handling', () => {
  assert.deepEqual(normalizeCustomFilterEntry({ op: 'none_of', value: '__country__:Spain' }), {
    op: 'none_of', kind: 'country', values: ['Spain'],
  });
  assert.equal(normalizeCustomFilterEntry({ op: 'none_of', value: '__country__:' }), null);
});

test('normalize: text operator objects strip the __text__ prefix', () => {
  assert.deepEqual(normalizeCustomFilterEntry({ op: 'not_contains', value: '__text__:abc' }), {
    op: 'not_contains', kind: 'text', value: 'abc',
  });
  assert.deepEqual(normalizeCustomFilterEntry({ op: 'equals', value: 'abc' }), {
    op: 'equals', kind: 'text', value: 'abc',
  });
  assert.equal(normalizeCustomFilterEntry({ op: 'not_contains', value: '' }), null);
});

test('normalize: unknown op or malformed object is null', () => {
  assert.equal(normalizeCustomFilterEntry({ op: 'like', value: 'x' }), null);
  assert.equal(normalizeCustomFilterEntry({ value: 'x' }), null);
  assert.equal(normalizeCustomFilterEntry({ op: 'none_of', value: 42 }), null);
});

// ---------------------------------------------------------------------------
// prefEntryNeedsAntiJoin
// ---------------------------------------------------------------------------

test('anti-join required exactly for none_of / not_contains / empty', () => {
  assert.equal(prefEntryNeedsAntiJoin({ op: 'none_of' }), true);
  assert.equal(prefEntryNeedsAntiJoin({ op: 'not_contains' }), true);
  assert.equal(prefEntryNeedsAntiJoin({ op: 'empty' }), true);
  assert.equal(prefEntryNeedsAntiJoin({ op: 'any_of' }), false);
  assert.equal(prefEntryNeedsAntiJoin({ op: 'contains' }), false);
  assert.equal(prefEntryNeedsAntiJoin({ op: 'equals' }), false);
  assert.equal(prefEntryNeedsAntiJoin({ op: 'bool_is' }), false);
  assert.equal(prefEntryNeedsAntiJoin({ op: 'not_empty' }), false);
});

// ---------------------------------------------------------------------------
// applyPrefFilterEntry — embed conditions per op
// ---------------------------------------------------------------------------

test('applyPrefFilterEntry always pins the field id on the alias', () => {
  const q = makeQueryStub();
  applyPrefFilterEntry(q, 'pv0', 'field-1', { op: 'not_empty', kind: 'any' });
  assert.deepEqual(q.calls[0], ['eq', 'pv0.field_id', 'field-1']);
});

test('applyPrefFilterEntry: any_of/none_of build the same option OR', () => {
  for (const op of ['any_of', 'none_of']) {
    const q = makeQueryStub();
    applyPrefFilterEntry(q, 'pv0', 'f', { op, kind: 'option', values: ['A'] });
    const orCall = q.calls.find(c => c[0] === 'or');
    assert.ok(orCall, `${op} should call .or`);
    assert.match(orCall[1], /value\.eq\."A"/);
    assert.match(orCall[1], /value\.ilike\./); // JSON-array storage variant
    assert.deepEqual(orCall[2], { foreignTable: 'pv0' });
  }
});

test('applyPrefFilterEntry: country entries use buildCountryConditions when given', () => {
  const q = makeQueryStub();
  applyPrefFilterEntry(q, 'pv1', 'f', { op: 'none_of', kind: 'country', values: ['Spain'] }, {
    buildCountryConditions: (names) => `custom.for.${names.join('+')}`,
  });
  const orCall = q.calls.find(c => c[0] === 'or');
  assert.equal(orCall[1], 'custom.for.Spain');
});

test('applyPrefFilterEntry: contains/not_contains use the same ilike pattern', () => {
  for (const op of ['contains', 'not_contains']) {
    const q = makeQueryStub();
    applyPrefFilterEntry(q, 'pv0', 'f', { op, kind: 'text', value: 'abc' });
    const ilikeCall = q.calls.find(c => c[0] === 'ilike');
    assert.deepEqual(ilikeCall, ['ilike', 'pv0.value', '%abc%']);
  }
});

test('applyPrefFilterEntry: equals matches scalar OR JSON-array element', () => {
  const q = makeQueryStub();
  applyPrefFilterEntry(q, 'pv0', 'f', { op: 'equals', kind: 'text', value: 'abc' });
  const orCall = q.calls.find(c => c[0] === 'or');
  assert.match(orCall[1], /value\.ilike\."abc"/);
  assert.match(orCall[1], /\*\\"abc\\"\*/); // JSON-encoded element wildcard
});

test('applyPrefFilterEntry: empty/not_empty exclude blank sentinel values', () => {
  for (const op of ['empty', 'not_empty']) {
    const q = makeQueryStub();
    applyPrefFilterEntry(q, 'pv0', 'f', { op, kind: 'any' });
    const notCall = q.calls.find(c => c[0] === 'not');
    assert.deepEqual(notCall, ['not', 'pv0.value', 'in', '("","[]")']);
  }
});

// ---------------------------------------------------------------------------
// parseCoreFilters
// ---------------------------------------------------------------------------

const TEXT_COLS = { phone: {}, invoicing_email: {} };
const MIXED_COLS = { job_title: {}, organization_id: { idColumn: true } };

test('parseCoreFilters: empty/garbage input yields no filters', () => {
  assert.deepEqual(parseCoreFilters('', TEXT_COLS), []);
  assert.deepEqual(parseCoreFilters(undefined, TEXT_COLS), []);
  assert.deepEqual(parseCoreFilters('not-json', TEXT_COLS), []);
  assert.deepEqual(parseCoreFilters('[1,2]', TEXT_COLS), []);
});

test('parseCoreFilters: whitelists columns and validates ops per column type', () => {
  const raw = JSON.stringify({
    phone: { op: 'contains', value: '07' },
    hacked_column: { op: 'contains', value: 'x' },
    invoicing_email: { op: 'any_of', value: 'x' }, // id-op on text col -> dropped
  });
  const parsed = parseCoreFilters(raw, TEXT_COLS);
  assert.deepEqual(parsed, [{ col: 'phone', op: 'contains', value: '07', idColumn: false }]);
});

test('parseCoreFilters: id columns accept any_of/none_of but not text ops', () => {
  const raw = JSON.stringify({
    organization_id: { op: 'none_of', value: 'org-1' },
    job_title: { op: 'none_of', value: 'x' }, // id-op on text col -> dropped
  });
  const parsed = parseCoreFilters(raw, MIXED_COLS);
  assert.deepEqual(parsed, [{ col: 'organization_id', op: 'none_of', value: 'org-1', values: ['org-1'], idColumn: true }]);
});

test('parseCoreFilters: id columns accept multiple ids (array or comma list)', () => {
  const raw = JSON.stringify({
    organization_id: { op: 'none_of', value: ['org-1', ' org-2 ', ''] },
    role_id: { op: 'any_of', value: 'r1, r2' },
  });
  const parsed = parseCoreFilters(raw, { ...MIXED_COLS, role_id: { idColumn: true } });
  assert.deepEqual(parsed, [
    { col: 'organization_id', op: 'none_of', value: 'org-1', values: ['org-1', 'org-2'], idColumn: true },
    { col: 'role_id', op: 'any_of', value: 'r1', values: ['r1', 'r2'], idColumn: true },
  ]);
});

test('parseCoreFilters: emptiness ops need no value; value ops need one', () => {
  const raw = JSON.stringify({
    phone: { op: 'empty' },
    invoicing_email: { op: 'contains', value: '   ' },
  });
  const parsed = parseCoreFilters(raw, TEXT_COLS);
  assert.deepEqual(parsed, [{ col: 'phone', op: 'empty', idColumn: false }]);
});

test('parseCoreFilters: caps the number of accepted filters at 10', () => {
  const obj = {};
  const cols = {};
  for (let i = 0; i < 15; i++) {
    obj[`c${i}`] = { op: 'contains', value: 'x' };
    cols[`c${i}`] = {};
  }
  assert.equal(parseCoreFilters(JSON.stringify(obj), cols).length, 10);
});

// ---------------------------------------------------------------------------
// applyDirectColumnFilter
// ---------------------------------------------------------------------------

test('applyDirectColumnFilter: text contains -> ilike with wildcards', () => {
  const q = makeQueryStub();
  applyDirectColumnFilter(q, { col: 'phone', op: 'contains', value: '07', idColumn: false });
  assert.deepEqual(q.calls, [['ilike', 'phone', '%07%']]);
});

test('applyDirectColumnFilter: text not_contains treats NULL/empty as not containing', () => {
  const q = makeQueryStub();
  applyDirectColumnFilter(q, { col: 'phone', op: 'not_contains', value: '07', idColumn: false });
  assert.equal(q.calls.length, 1);
  const [m, cond] = q.calls[0];
  assert.equal(m, 'or');
  assert.match(cond, /phone\.is\.null/);
  assert.match(cond, /phone\.eq\.""/);
  assert.match(cond, /phone\.not\.ilike\."\*07\*"/);
});

test('applyDirectColumnFilter: text equals is case-insensitive with literal wildcards', () => {
  const q = makeQueryStub();
  applyDirectColumnFilter(q, { col: 'phone', op: 'equals', value: '100%', idColumn: false });
  assert.deepEqual(q.calls, [['ilike', 'phone', '100\\%']]);
});

test('applyDirectColumnFilter: text empty/not_empty handle NULL and empty string', () => {
  let q = makeQueryStub();
  applyDirectColumnFilter(q, { col: 'phone', op: 'empty', idColumn: false });
  assert.deepEqual(q.calls, [['or', 'phone.is.null,phone.eq.""']]);

  q = makeQueryStub();
  applyDirectColumnFilter(q, { col: 'phone', op: 'not_empty', idColumn: false });
  assert.deepEqual(q.calls, [
    ['not', 'phone', 'is', null],
    ['neq', 'phone', ''],
  ]);
});

test('applyDirectColumnFilter: id column ops', () => {
  let q = makeQueryStub();
  applyDirectColumnFilter(q, { col: 'organization_id', op: 'any_of', value: 'org-1', idColumn: true });
  assert.deepEqual(q.calls, [['eq', 'organization_id', 'org-1']]);

  q = makeQueryStub();
  applyDirectColumnFilter(q, { col: 'organization_id', op: 'none_of', value: 'org-1', idColumn: true });
  assert.deepEqual(q.calls, [['or', 'organization_id.is.null,organization_id.neq."org-1"']]);

  q = makeQueryStub();
  applyDirectColumnFilter(q, { col: 'organization_id', op: 'empty', idColumn: true });
  assert.deepEqual(q.calls, [['is', 'organization_id', null]]);

  q = makeQueryStub();
  applyDirectColumnFilter(q, { col: 'organization_id', op: 'not_empty', idColumn: true });
  assert.deepEqual(q.calls, [['not', 'organization_id', 'is', null]]);
});

// ---------------------------------------------------------------------------
// escaping helpers
// ---------------------------------------------------------------------------

test('quoteForOr escapes quotes and backslashes', () => {
  assert.equal(quoteForOr('a"b'), '"a\\"b"');
  assert.equal(quoteForOr('a\\b'), '"a\\\\b"');
});

test('escapeIlikeWildcards escapes %, _ and backslash', () => {
  assert.equal(escapeIlikeWildcards('100%_x\\'), '100\\%\\_x\\\\');
});
