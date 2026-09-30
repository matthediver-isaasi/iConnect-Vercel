import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPreferenceValues } from './aggregation.js';

// Fake PostgREST client that enforces the real-world 1000-row response cap.
// It records the queries it receives so the test can assert on ordering and
// pagination behaviour.
function makeFakeClient({ rows, cap = 1000, failOnFirstCall = false }) {
  const calls = [];
  let callCount = 0;
  return {
    calls,
    from(table) {
      const q = {
        table,
        filters: {},
        orders: [],
        rangeArgs: null,
        select() { return q; },
        in(col, values) { q.filters[col] = values; return q; },
        order(col, opts) { q.orders.push([col, opts]); return q; },
        range(from, to) {
          q.rangeArgs = [from, to];
          calls.push(q);
          callCount += 1;
          if (failOnFirstCall && callCount === 1) {
            return Promise.resolve({ data: null, error: { message: 'boom' } });
          }
          const idSet = new Set(q.filters.organization_id || []);
          const fieldSet = new Set(q.filters.field_id || []);
          const matched = rows.filter(
            r => idSet.has(r.organization_id) && fieldSet.has(r.field_id),
          );
          // Deterministic order (mirrors the .order() clauses).
          matched.sort((a, b) =>
            a.organization_id.localeCompare(b.organization_id)
            || a.field_id.localeCompare(b.field_id));
          const page = matched.slice(from, Math.min(to + 1, from + cap));
          return Promise.resolve({ data: page, error: null });
        },
      };
      return q;
    },
  };
}

test('loadPreferenceValues survives >1000 preference rows per id-chunk', async () => {
  // 500 orgs x 4 fields = 2000 preference rows in ONE id-chunk — double the
  // PostgREST cap. Before the fix, rows past 1000 were silently dropped.
  const fieldIds = ['f1', 'f2', 'f3', 'f4'];
  const ids = Array.from({ length: 500 }, (_, i) => `org-${String(i).padStart(4, '0')}`);
  const rows = [];
  for (const id of ids) {
    for (const f of fieldIds) {
      rows.push({ organization_id: id, field_id: f, value: `${id}:${f}` });
    }
  }
  const client = makeFakeClient({ rows });

  const map = await loadPreferenceValues({
    table: 'organization_preference_value',
    fkColumn: 'organization_id',
    ids,
    fieldIds,
    client,
  });

  assert.equal(map.size, 500, 'every org must have preference values');
  for (const id of ids) {
    const prefs = map.get(id);
    assert.ok(prefs, `missing prefs for ${id}`);
    for (const f of fieldIds) {
      assert.equal(prefs[f], `${id}:${f}`);
    }
  }
  // Must have paginated (2000 rows / 1000-cap => at least 2 requests).
  assert.ok(client.calls.length >= 2, 'expected paginated requests');
  // Every request must carry a stable ordering for .range() correctness.
  for (const q of client.calls) {
    assert.deepEqual(q.orders.map(o => o[0]), ['organization_id', 'field_id']);
    assert.ok(q.rangeArgs, 'expected .range() on every request');
  }
});

test('loadPreferenceValues throws on query error instead of silently continuing', async () => {
  const client = makeFakeClient({
    rows: [{ organization_id: 'org-1', field_id: 'f1', value: 'x' }],
    failOnFirstCall: true,
  });
  await assert.rejects(
    loadPreferenceValues({
      table: 'organization_preference_value',
      fkColumn: 'organization_id',
      ids: ['org-1'],
      fieldIds: ['f1'],
      client,
    }),
    /Preference value query failed: boom/,
  );
});

// ---------------------------------------------------------------------------
// listGroupKeys: group-by on multi-pick (list-typed) fields must bucket a
// row under EVERY element, not just its first — otherwise widgets like
// "Unique countries of operation" under-count vs the list page.
import { listGroupKeys } from './aggregation.js';

test('listGroupKeys buckets a row under every list element', () => {
  assert.deepEqual(listGroupKeys(['Kenya', 'India']), ['Kenya', 'India']);
  // NOTE: stored JSON strings are parsed by parsePreferenceValue BEFORE
  // reaching the group-by path, so listGroupKeys always receives real
  // arrays (or scalars) — never raw JSON text.
  assert.deepEqual(listGroupKeys(['India', 'India']), ['India'], 'duplicates collapse');
  assert.deepEqual(listGroupKeys([]), ['Unspecified']);
  assert.deepEqual(listGroupKeys(null), ['Unspecified']);
  assert.deepEqual(listGroupKeys('India'), ['India'], 'scalar treated as one-element list');
});

// ---------------------------------------------------------------------------
// countryGroupKeys: country-shaped group-bys (system `country` column or
// custom country/countries fields) must merge name/code storage variants into
// one ISO-2 bucket even WITHOUT an LMIC filter — otherwise "Kenya" and "KE"
// appear as two separate buckets. Unresolvable values keep their raw string
// so no data is hidden.
import { countryGroupKeys } from './aggregation.js';

test('countryGroupKeys merges name and code storage into one ISO-2 bucket', () => {
  assert.deepEqual(countryGroupKeys(['Kenya']), ['KE']);
  assert.deepEqual(countryGroupKeys(['KE']), ['KE']);
  assert.deepEqual(countryGroupKeys(['Kenya', 'KE']), ['KE'], 'variants dedupe');
  assert.deepEqual(countryGroupKeys(['ke']), ['KE'], 'lowercase codes normalise');
});

test('countryGroupKeys buckets a row under every list element', () => {
  assert.deepEqual(countryGroupKeys(['Kenya', 'India', 'United Kingdom']), ['KE', 'IN', 'GB']);
});

test('countryGroupKeys handles scalar values (system country column)', () => {
  assert.deepEqual(countryGroupKeys('KE'), ['KE']);
  assert.deepEqual(countryGroupKeys('Kenya'), ['KE']);
});

test('countryGroupKeys resolves World Bank-style name variants', () => {
  assert.deepEqual(
    countryGroupKeys(['Congo, Dem. Rep.', 'Egypt, Arab Rep.', 'Lao PDR', 'Côte d\u2019Ivoire']),
    ['CD', 'EG', 'LA', 'CI'],
  );
});

test('countryGroupKeys keeps unresolvable values as raw bucket keys', () => {
  assert.deepEqual(countryGroupKeys(['Narnia']), ['Narnia'], 'no data hidden');
  assert.deepEqual(countryGroupKeys(['Kenya', 'Narnia']), ['KE', 'Narnia']);
});

test('countryGroupKeys falls back to Unspecified for empty values', () => {
  assert.deepEqual(countryGroupKeys([]), ['Unspecified']);
  assert.deepEqual(countryGroupKeys(null), ['Unspecified']);
  assert.deepEqual(countryGroupKeys(''), ['Unspecified']);
});

// ---------------------------------------------------------------------------
// pruneLmicGroupKeys: when the group-by field is the SAME field carrying an
// `lmic` filter, group keys must be pruned element-wise to LMIC-only ISO-2
// codes — otherwise a row admitted by ANY LMIC element gets bucketed under
// its non-LMIC countries too (e.g. "United Kingdom" appearing in an
// LMIC-only country breakdown).
import { pruneLmicGroupKeys } from './aggregation.js';

test('pruneLmicGroupKeys keeps only LMIC elements as ISO-2 codes', () => {
  const lmic = new Set(['KE', 'IN']);
  assert.deepEqual(
    pruneLmicGroupKeys(['Kenya', 'United Kingdom', 'India'], lmic),
    ['KE', 'IN'],
    'non-LMIC elements are pruned; keys are normalised codes',
  );
});

test('pruneLmicGroupKeys merges name and code storage into one bucket', () => {
  const lmic = new Set(['KE']);
  assert.deepEqual(pruneLmicGroupKeys(['Kenya'], lmic), ['KE']);
  assert.deepEqual(pruneLmicGroupKeys(['KE'], lmic), ['KE']);
  assert.deepEqual(pruneLmicGroupKeys(['Kenya', 'KE'], lmic), ['KE'], 'variants dedupe');
});

test('pruneLmicGroupKeys yields no bucket (not Unspecified) when nothing survives', () => {
  const lmic = new Set(['KE']);
  assert.deepEqual(pruneLmicGroupKeys(['United Kingdom', 'France'], lmic), []);
  assert.deepEqual(pruneLmicGroupKeys([], lmic), []);
  assert.deepEqual(pruneLmicGroupKeys(null, lmic), []);
});

test('pruneLmicGroupKeys resolves World Bank-style name variants', () => {
  const lmic = new Set(['CD', 'EG', 'LA', 'CI', 'KG']);
  assert.deepEqual(
    pruneLmicGroupKeys(
      ['Congo, Dem. Rep.', 'Egypt, Arab Rep.', 'Lao PDR', 'Côte d\u2019Ivoire', 'Kyrgyz Republic'],
      lmic,
    ),
    ['CD', 'EG', 'LA', 'CI', 'KG'],
    'aliases and curly apostrophes resolve to ISO-2',
  );
});

test('pruneLmicGroupKeys handles scalar values and empty LMIC sets', () => {
  assert.deepEqual(pruneLmicGroupKeys('Kenya', new Set(['KE'])), ['KE'], 'scalar country field');
  assert.deepEqual(pruneLmicGroupKeys('United Kingdom', new Set(['KE'])), []);
  assert.deepEqual(pruneLmicGroupKeys(['Kenya'], new Set()), [], 'empty LMIC list yields no rows');
  assert.deepEqual(pruneLmicGroupKeys(['Kenya'], null), []);
  assert.deepEqual(pruneLmicGroupKeys(['Narnia'], new Set(['KE'])), [], 'unresolvable values do not bucket');
});

// ---------------------------------------------------------------------------
// sortGroupedRows: grouped rows keep the historical value-descending sort
// UNLESS a region bucket order is supplied (region group-by with an explicit
// scheme), in which case rows follow the scheme's stable display order —
// regions first, then Multi-region, then Unknown — regardless of the data
// distribution. Scheme-less region widgets must keep the legacy sort so
// existing output is byte-for-byte unchanged.
import { sortGroupedRows } from './aggregation.js';
import { regionBucketsForScheme } from '../../../shared/countryRegions.js';

test('sortGroupedRows without a bucket order keeps the legacy value-desc sort', () => {
  const rows = [
    { key: 'Asia', value: 2 },
    { key: 'Africa', value: 9 },
    { key: 'Unknown', value: 5 },
  ];
  sortGroupedRows(rows);
  assert.deepEqual(rows.map(r => r.key), ['Africa', 'Unknown', 'Asia']);
});

test('sortGroupedRows orders app-scheme buckets in stable display order', () => {
  const rows = [
    { key: 'Unknown', value: 50 },
    { key: 'Multi-region', value: 40 },
    { key: 'Europe', value: 30 },
    { key: 'Africa', value: 1 },
  ];
  sortGroupedRows(rows, regionBucketsForScheme('app'));
  assert.deepEqual(
    rows.map(r => r.key),
    ['Africa', 'Europe', 'Multi-region', 'Unknown'],
    'scheme order wins over value order',
  );
});

test('sortGroupedRows orders World Bank buckets in stable display order', () => {
  const rows = [
    { key: 'Unknown', value: 99 },
    { key: 'Europe & Central Asia', value: 3 },
    { key: 'Sub-Saharan Africa', value: 1 },
    { key: 'South Asia', value: 7 },
  ];
  sortGroupedRows(rows, regionBucketsForScheme('world_bank'));
  assert.deepEqual(
    rows.map(r => r.key),
    ['Sub-Saharan Africa', 'South Asia', 'Europe & Central Asia', 'Unknown'],
  );
});

test('sortGroupedRows puts unexpected keys last, value-desc among themselves', () => {
  const rows = [
    { key: 'Mystery B', value: 1 },
    { key: 'Africa', value: 2 },
    { key: 'Mystery A', value: 8 },
  ];
  sortGroupedRows(rows, regionBucketsForScheme('app'));
  assert.deepEqual(rows.map(r => r.key), ['Africa', 'Mystery A', 'Mystery B']);
});

// ---------------------------------------------------------------------------
// mapFieldType: 'countries' custom fields store arrays (multi-pick) exactly
// like 'list' fields, so they MUST map to 'list' — otherwise group-by,
// filters, and count-distinct silently fall back to first-element semantics
// and widgets under-count vs the list pages (the "47 vs 60 India" bug).
import { mapFieldType } from './sources.js';

test('mapFieldType treats multi-pick field types as list', () => {
  assert.equal(mapFieldType('list'), 'list');
  assert.equal(mapFieldType('countries'), 'list');
  // Singular 'country' is single-pick and must stay text.
  assert.equal(mapFieldType('country'), 'text');
  assert.equal(mapFieldType('picklist'), 'enum');
  assert.equal(mapFieldType('dropdown'), 'enum');
  assert.equal(mapFieldType('number'), 'number');
});
