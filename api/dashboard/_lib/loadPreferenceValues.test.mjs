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
