import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeRecordFilters,
  boundedLabels,
  buildRecordQueryString,
  chainedValuesFor,
  initialRecordListState,
  normalizeListMetadata,
  reconcileFilters,
  reconcileColumns,
  reconcileOrder,
  recordListReducer,
  relationshipValuesFor,
} from './recordListHelpers.mjs';

test('saved ordering is reconciled by dropping stale ids and appending new ids', () => {
  assert.deepEqual(
    reconcileOrder(['b', 'stale', 'b', 'a'], ['a', 'b', 'c']),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(reconcileOrder(null, ['a', 'b']), ['a', 'b']);
});

test('column reconciliation preserves explicit visibility and adds metadata columns', () => {
  const available = [
    { id: 'name', locked: true },
    { id: 'new-field' },
    { id: 'updated_at' },
  ];
  assert.deepEqual(
    reconcileColumns(
      [{ id: 'updated_at', visible: false }, { id: 'removed', visible: true }, { id: 'name', visible: false }],
      available,
      ['name', 'new-field'],
    ).map(({ id, visible }) => ({ id, visible })),
    [
      { id: 'updated_at', visible: false },
      { id: 'name', visible: true },
      { id: 'new-field', visible: true },
    ],
  );
});

test('saved chained column selection and ordering persist by server-issued ID', () => {
  const chainedId = 'chain:department-members:projects:name';
  const columns = reconcileColumns([
    { id: 'updated_at', visible: false },
    { id: chainedId, visible: true },
    { id: 'chain:removed', visible: true },
  ], [
    { id: 'name', locked: true },
    { id: chainedId, kind: 'chained', sortable: false, filterable: false },
    { id: 'updated_at' },
  ], ['name']);
  assert.deepEqual(columns.map(({ id, visible }) => ({ id, visible })), [
    { id: 'updated_at', visible: false },
    { id: chainedId, visible: true },
    { id: 'name', visible: true },
  ]);
});

test('incomplete chained metadata retains saved chained choices until discovery recovers', () => {
  const chained = {
    id: 'chain:department-members:projects:name',
    kind: 'chained',
    label: 'Members → Projects',
    visible: true,
  };
  const columns = reconcileColumns([chained], [
    { id: 'name', locked: true },
    { id: 'updated_at' },
  ], ['name'], { preserveUnavailableChained: true });
  assert.deepEqual(columns.map(({ id, kind, visible }) => ({ id, kind, visible })), [
    { id: chained.id, kind: 'chained', visible: true },
    { id: 'name', kind: undefined, visible: true },
    { id: 'updated_at', kind: undefined, visible: false },
  ]);
  assert.equal(
    reconcileColumns([chained], [{ id: 'name', locked: true }], ['name']).some((column) =>
      column.id === chained.id),
    false,
  );
});

test('relationship metadata and values support map and array response shapes', () => {
  const metadata = normalizeListMetadata({
    list_metadata: {
      relationship_columns: [{
        relationship_definition_id: 'rel-1',
        label: 'Projects',
        values: [{ id: 'p1', label: 'One' }],
      }],
    },
  }, []);
  assert.equal(metadata.relationships[0].id, 'relationship:rel-1');
  assert.equal(
    boundedLabels(relationshipValuesFor({
      relationship_values: { 'rel-1': [{ display_value: 'One' }, { display_value: 'Two' }] },
    }, metadata.relationships[0])),
    'One, Two',
  );
  assert.equal(
    boundedLabels(relationshipValuesFor({
      relationships: {
        'relationship:rel-1': {
          count: 2,
          records: [{ primary_label: 'One' }, { primary_label: 'Two' }],
        },
      },
    }, metadata.relationships[0])),
    'One, Two',
  );
  assert.equal(
    boundedLabels(relationshipValuesFor({
      relationship_values: [{
        relationship_definition_id: 'rel-1',
        records: [{ label: 'One' }, { label: 'Two' }],
      }],
    }, metadata.relationships[0])),
    'One, Two',
  );
});

test('server-authorized chained columns retain stable IDs and summarize exact counts', () => {
  const metadata = normalizeListMetadata({
    list_metadata: {
      chained_columns: [{
        id: 'chain:department-members:projects:name',
        version: 1,
        label: 'Members → Projects',
        path: [{ relationship_definition_id: 'department-members', from_side: 'source' }],
        endpoint: { kind: 'custom_object', custom_object_id: 'project' },
        terminal: { kind: 'field', field_id: 'project-name' },
        sortable: true,
        filterable: true,
      }],
    },
  });
  assert.deepEqual(metadata.chainedColumns.map(({ id, kind, sortable, filterable }) => ({
    id, kind, sortable, filterable,
  })), [{
    id: 'chain:department-members:projects:name',
    kind: 'chained',
    sortable: false,
    filterable: false,
  }]);
  assert.equal(metadata.chainedColumnsError, null);
  assert.equal(
    boundedLabels(chainedValuesFor({
      chained_values: {
        'chain:department-members:projects:name': {
          count: 5,
          records: [{ label: 'Apollo' }, { label: 'Borealis' }, { label: 'Cygnus' }],
        },
      },
    }, metadata.chainedColumns[0]), 3),
    'Apollo, Borealis, Cygnus +2 more',
  );
});

test('chained discovery errors are surfaced without manufacturing selectable columns', () => {
  const metadata = normalizeListMetadata({
    metadata: {
      chained_columns_error: 'Traversal limit exceeded',
    },
  });
  assert.equal(metadata.chainedColumnsError, 'Traversal limit exceeded');
  assert.deepEqual(metadata.chainedColumns, []);
});

test('multi relationship labels are bounded and communicate cardinality', () => {
  assert.equal(boundedLabels([], 2), '—');
  assert.equal(
    boundedLabels(['Alpha', 'Beta', 'Gamma', 'Delta'], 2),
    'Alpha, Beta +2 more',
  );
  assert.equal(
    boundedLabels({ values: ['Alpha', 'Beta', 'Gamma'], count: 11 }, 3),
    'Alpha, Beta, Gamma +8 more',
  );
});

test('record list reducer replaces a saved view without leaking prior state', () => {
  const dirty = {
    ...initialRecordListState,
    page: 8,
    search: 'old',
    searchInput: 'old',
    filters: { stale: { op: 'equals', value: 'x' } },
    includeArchived: true,
  };
  const next = recordListReducer(dirty, {
    type: 'replace',
    value: { search: 'new', filters: {}, sortField: 'title', sortDir: 'asc' },
  });
  assert.equal(next.page, 1);
  assert.equal(next.searchInput, 'new');
  assert.deepEqual(next.filters, {});
  assert.equal(next.includeArchived, false);
});

test('saved filters reconcile stale fields, relationships, and operators', () => {
  const result = reconcileFilters({
    current: { op: 'equals', value: 'open' },
    stale: { op: 'equals', value: 'gone' },
    relationship: { op: 'contains', value: ['record-1'] },
  }, [
    { id: 'current', operators: [{ value: 'equals' }, { value: 'contains' }] },
    { id: 'relationship', operators: ['any_of', 'none_of'] },
  ]);
  assert.deepEqual(result, {
    current: { op: 'equals', value: 'open' },
  });
});

test('query serialization and export can share exact active criteria', () => {
  const state = {
    ...initialRecordListState,
    page: 3,
    search: 'needle',
    includeArchived: true,
    filters: {
      empty: { op: 'equals', value: '' },
      related: { op: 'any_of', value: ['r1', 'r2'] },
      absent: { op: 'is_empty', value: '' },
    },
  };
  assert.deepEqual(Object.keys(activeRecordFilters(state.filters)), ['related', 'absent']);
  const relationshipColumns = ['relationship:rel-1:source'];
  const chainedColumns = ['chain:department-members:projects:name'];
  const list = new URLSearchParams(buildRecordQueryString(state, {
    relationshipColumns, chainedColumns,
  }));
  const exported = new URLSearchParams(buildRecordQueryString(state, {
    page: 1, pageSize: 1000, relationshipColumns, chainedColumns,
  }));
  for (const key of ['search', 'sortField', 'sortDir', 'includeArchived', 'filters', 'relationshipColumns', 'chainedColumns'])
    assert.equal(exported.get(key), list.get(key));
  assert.equal(exported.get('page'), '1');
  assert.equal(exported.get('pageSize'), '1000');
});