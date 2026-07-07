// Task #2419: Member AI structured data Q&A — unit tests for the whitelisted
// query-spec validation and the visibility predicates of the structured path.
// Follows the api/_lib/*.test.mjs convention (node --test, no DB/LLM mocking:
// only the pure exports are exercised).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateQuerySpec,
  isMemberRowVisible,
  isOrgRowVisible,
  isEventRowVisible,
  isComplexEventRowVisible,
  isResourceRowVisible,
  matchesPrefValue,
  prefValueEntries,
  isPrefFieldDirectoryVisible,
  matchesColumnFilter,
  groupAndCount,
  computeNumericAggregate,
  groupAndAggregate,
  templateStructuredAnswer,
  looksLikeStructuredQuestion,
  buildPlannerCatalog,
  STRUCTURED_ENTITIES,
  MAX_FILTERS,
  MAX_GROUPS,
} from './memberAiStructured.js';

// ---------------------------------------------------------------------------
// Query-spec validation: whitelist enforcement
// ---------------------------------------------------------------------------

const PREF_FIELDS = [
  {
    id: 'pf-school-type',
    label: 'School Type',
    entity_scope: 'organization',
    is_active: true,
  },
  {
    id: 'pf-region',
    label: 'Region',
    entity_scope: 'member',
    is_active: true,
  },
  {
    id: 'pf-inactive',
    label: 'Old Field',
    entity_scope: 'organization',
    is_active: false,
  },
];

test('validateQuerySpec: rejects unknown entities', () => {
  const r = validateQuerySpec({ entity: 'invoice', aggregation: 'count' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Unknown entity/);
});

test('validateQuerySpec: rejects non-object and missing aggregation', () => {
  assert.equal(validateQuerySpec(null).ok, false);
  assert.equal(
    validateQuerySpec({ entity: 'organization', aggregation: 'sum' }).ok,
    false
  );
});

test('validateQuerySpec: accepts a simple count with a native column filter', () => {
  const r = validateQuerySpec(
    {
      entity: 'organization',
      aggregation: 'count',
      filters: [{ field: 'address', op: 'contains', value: 'South Africa' }],
    },
    { prefFields: PREF_FIELDS }
  );
  assert.equal(r.ok, true);
  assert.equal(r.spec.entity, 'organization');
  assert.deepEqual(r.spec.filters[0], {
    kind: 'column',
    field: 'address',
    op: 'contains',
    value: 'South Africa',
  });
});

test('validateQuerySpec: rejects unknown filter fields', () => {
  const r = validateQuerySpec(
    {
      entity: 'organization',
      aggregation: 'count',
      filters: [{ field: 'vat_number', op: 'eq', value: 'x' }],
    },
    { prefFields: PREF_FIELDS }
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /Unknown filter field/);
});

test('validateQuerySpec: rejects unsupported filter ops and bad values', () => {
  const base = { entity: 'organization', aggregation: 'count' };
  assert.equal(
    validateQuerySpec({
      ...base,
      filters: [{ field: 'address', op: 'gt', value: 'x' }],
    }).ok,
    false
  );
  assert.equal(
    validateQuerySpec({
      ...base,
      filters: [{ field: 'address', op: 'eq', value: { $ne: null } }],
    }).ok,
    false
  );
  assert.equal(
    validateQuerySpec({
      ...base,
      filters: [{ field: 'address', op: 'eq', value: 'x'.repeat(500) }],
    }).ok,
    false
  );
  assert.equal(
    validateQuerySpec({
      ...base,
      filters: [{ field: 'address', op: 'eq', value: '   ' }],
    }).ok,
    false
  );
});

test('validateQuerySpec: caps the number of filters', () => {
  const filters = Array.from({ length: MAX_FILTERS + 1 }, () => ({
    field: 'address',
    op: 'contains',
    value: 'ZA',
  }));
  const r = validateQuerySpec({
    entity: 'organization',
    aggregation: 'count',
    filters,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Too many filters/);
});

test('validateQuerySpec: resolves preference fields by pref:id, id, and label', () => {
  for (const ref of ['pref:pf-school-type', 'pf-school-type', 'school type']) {
    const r = validateQuerySpec(
      {
        entity: 'organization',
        aggregation: 'count',
        filters: [{ field: ref, op: 'eq', value: 'Primary' }],
      },
      { prefFields: PREF_FIELDS }
    );
    assert.equal(r.ok, true, `ref ${ref} should resolve`);
    assert.equal(r.spec.filters[0].kind, 'preference');
    assert.equal(r.spec.filters[0].fieldId, 'pf-school-type');
  }
});

test('validateQuerySpec: rejects preference fields from another scope or inactive', () => {
  // member-scoped field used on organization entity
  const wrongScope = validateQuerySpec(
    {
      entity: 'organization',
      aggregation: 'count',
      filters: [{ field: 'pref:pf-region', op: 'eq', value: 'North' }],
    },
    { prefFields: PREF_FIELDS }
  );
  assert.equal(wrongScope.ok, false);

  const inactive = validateQuerySpec(
    {
      entity: 'organization',
      aggregation: 'count',
      filters: [{ field: 'pref:pf-inactive', op: 'eq', value: 'x' }],
    },
    { prefFields: PREF_FIELDS }
  );
  assert.equal(inactive.ok, false);
});

test('validateQuerySpec: entities without pref scope reject preference refs', () => {
  const r = validateQuerySpec(
    {
      entity: 'event',
      aggregation: 'count',
      filters: [{ field: 'pref:pf-region', op: 'eq', value: 'North' }],
    },
    { prefFields: PREF_FIELDS }
  );
  assert.equal(r.ok, false);
});

test('validateQuerySpec: count_by requires a groupable field', () => {
  const ok = validateQuerySpec(
    { entity: 'organization', aggregation: 'count_by', groupBy: 'tags' },
    { prefFields: PREF_FIELDS }
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.spec.groupBy, { kind: 'column', field: 'tags' });

  // name is whitelisted but not groupable
  const notGroupable = validateQuerySpec({
    entity: 'organization',
    aggregation: 'count_by',
    groupBy: 'name',
  });
  assert.equal(notGroupable.ok, false);
  assert.match(notGroupable.reason, /not groupable/);

  const unknown = validateQuerySpec({
    entity: 'organization',
    aggregation: 'count_by',
    groupBy: 'shoe_size',
  });
  assert.equal(unknown.ok, false);

  // preference fields are always groupable
  const pref = validateQuerySpec(
    {
      entity: 'organization',
      aggregation: 'count_by',
      groupBy: 'School Type',
    },
    { prefFields: PREF_FIELDS }
  );
  assert.equal(pref.ok, true);
  assert.equal(pref.spec.groupBy.kind, 'preference');
});

test('validateQuerySpec: groupBy forbidden for plain count', () => {
  const r = validateQuerySpec({
    entity: 'organization',
    aggregation: 'count',
    groupBy: 'tags',
  });
  assert.equal(r.ok, false);
});

test('validateQuerySpec: dateRange only on whitelisted date fields', () => {
  const ok = validateQuerySpec({
    entity: 'event',
    aggregation: 'count',
    dateRange: { field: 'start_date', from: '2026-01-01', to: '2026-12-31' },
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.spec.dateRange.from instanceof Date);

  const badField = validateQuerySpec({
    entity: 'event',
    aggregation: 'count',
    dateRange: { field: 'created_at', from: '2026-01-01' },
  });
  assert.equal(badField.ok, false);

  const badDate = validateQuerySpec({
    entity: 'event',
    aggregation: 'count',
    dateRange: { field: 'start_date', from: 'not-a-date' },
  });
  assert.equal(badDate.ok, false);

  const empty = validateQuerySpec({
    entity: 'event',
    aggregation: 'count',
    dateRange: { field: 'start_date' },
  });
  assert.equal(empty.ok, false);

  // organizations have no date fields at all
  const noDates = validateQuerySpec({
    entity: 'organization',
    aggregation: 'count',
    dateRange: { field: 'start_date', from: '2026-01-01' },
  });
  assert.equal(noDates.ok, false);
});

// ---------------------------------------------------------------------------
// Visibility predicates — mirror the member-facing surfaces
// ---------------------------------------------------------------------------

test('member visibility: show_in_directory / login_enabled / deleted email', () => {
  assert.equal(isMemberRowVisible({ email: 'a@b.com' }), true);
  assert.equal(
    isMemberRowVisible({ show_in_directory: null, login_enabled: null }),
    true
  );
  assert.equal(isMemberRowVisible({ show_in_directory: false }), false);
  assert.equal(isMemberRowVisible({ login_enabled: false }), false);
  assert.equal(
    isMemberRowVisible({ email: 'deleted_123@deleted.local' }),
    false
  );
  assert.equal(isMemberRowVisible(null), false);
});

test('org visibility: excluded org ids are filtered', () => {
  const excludedOrgIds = new Set(['org-2']);
  assert.equal(isOrgRowVisible({ id: 'org-1' }, { excludedOrgIds }), true);
  assert.equal(isOrgRowVisible({ id: 'org-2' }, { excludedOrgIds }), false);
  assert.equal(isOrgRowVisible({ id: 'org-3' }, {}), true);
});

test('event visibility: draft/unpublished never visible', () => {
  const ctx = { isAdmin: false, groupIds: new Set() };
  assert.equal(isEventRowVisible({ status: 'published' }, ctx), true);
  assert.equal(isEventRowVisible({ status: 'tbc' }, ctx), true);
  assert.equal(isEventRowVisible({ status: 'draft' }, ctx), false);
  assert.equal(isEventRowVisible({ status: 'cancelled' }, ctx), false);
  assert.equal(
    isEventRowVisible({ status: 'published', event_state: 'draft' }, ctx),
    false
  );
});

test('event visibility: group events gated by membership / public flag', () => {
  const groupEvent = { status: 'published', member_group_id: 'g1' };
  assert.equal(
    isEventRowVisible(groupEvent, { isAdmin: false, groupIds: new Set() }),
    false
  );
  assert.equal(
    isEventRowVisible(groupEvent, { isAdmin: false, groupIds: new Set(['g1']) }),
    true
  );
  assert.equal(
    isEventRowVisible(
      { ...groupEvent, group_event_public: true },
      { isAdmin: false, groupIds: new Set() }
    ),
    true
  );
  // admins bypass group gating but never see drafts
  assert.equal(isEventRowVisible(groupEvent, { isAdmin: true }), true);
  assert.equal(
    isEventRowVisible(
      { ...groupEvent, event_state: 'draft' },
      { isAdmin: true }
    ),
    false
  );
});

test('complex event visibility: event_state restricted to null/active/closed', () => {
  const ctx = { isAdmin: false, groupIds: new Set() };
  assert.equal(
    isComplexEventRowVisible({ status: 'published', event_state: null }, ctx),
    true
  );
  assert.equal(
    isComplexEventRowVisible({ status: 'published', event_state: 'active' }, ctx),
    true
  );
  assert.equal(
    isComplexEventRowVisible({ status: 'published', event_state: 'closed' }, ctx),
    true
  );
  assert.equal(
    isComplexEventRowVisible({ status: 'published', event_state: 'draft' }, ctx),
    false
  );
  assert.equal(
    isComplexEventRowVisible({ status: 'published', event_state: 'archived' }, ctx),
    false
  );
});

test('resource visibility: status, group and role gating', () => {
  const ctx = { isAdmin: false, roleId: 'r1', groupIds: new Set(['g1']) };
  assert.equal(isResourceRowVisible({ status: 'active' }, ctx), true);
  assert.equal(isResourceRowVisible({ status: 'draft' }, ctx), false);
  assert.equal(
    isResourceRowVisible({ status: 'active', member_group_id: 'g2' }, ctx),
    false
  );
  assert.equal(
    isResourceRowVisible({ status: 'active', member_group_id: 'g1' }, ctx),
    true
  );
  assert.equal(
    isResourceRowVisible(
      { status: 'active', allowed_role_ids: ['r2'] },
      ctx
    ),
    false
  );
  assert.equal(
    isResourceRowVisible(
      { status: 'active', allowed_role_ids: ['r1', 'r2'] },
      ctx
    ),
    true
  );
  // no role at all + role-gated resource -> hidden
  assert.equal(
    isResourceRowVisible(
      { status: 'active', allowed_role_ids: ['r1'] },
      { isAdmin: false, roleId: null, groupIds: new Set() }
    ),
    false
  );
  // empty allow-list means unrestricted
  assert.equal(
    isResourceRowVisible({ status: 'active', allowed_role_ids: [] }, ctx),
    true
  );
  // admins bypass member gating but not status
  assert.equal(
    isResourceRowVisible(
      { status: 'active', member_group_id: 'gX', allowed_role_ids: ['rX'] },
      { isAdmin: true }
    ),
    true
  );
  assert.equal(isResourceRowVisible({ status: 'draft' }, { isAdmin: true }), false);
});

test('pref field directory visibility mirrors the directory pages', () => {
  // directory_visibility JSON takes precedence
  assert.equal(
    isPrefFieldDirectoryVisible({
      entity_scope: 'organization',
      directory_visibility: '["main"]',
    }),
    true
  );
  assert.equal(
    isPrefFieldDirectoryVisible({
      entity_scope: 'organization',
      directory_visibility: '["other-dir"]',
      show_in_directory_card: true,
    }),
    false
  );
  assert.equal(
    isPrefFieldDirectoryVisible({
      entity_scope: 'member',
      directory_visibility: JSON.stringify({ ids: ['main'], labels: {} }),
    }),
    true
  );
  // fallback flags per scope
  assert.equal(
    isPrefFieldDirectoryVisible({ entity_scope: 'organization' }),
    true
  );
  assert.equal(
    isPrefFieldDirectoryVisible({
      entity_scope: 'organization',
      show_in_directory_card: false,
    }),
    false
  );
  assert.equal(
    isPrefFieldDirectoryVisible({
      entity_scope: 'member',
      show_in_member_directory: false,
    }),
    false
  );
  // malformed JSON falls back to flags
  assert.equal(
    isPrefFieldDirectoryVisible({
      entity_scope: 'member',
      directory_visibility: '[broken',
    }),
    true
  );
  assert.equal(isPrefFieldDirectoryVisible({ is_active: false }), false);
  assert.equal(isPrefFieldDirectoryVisible(null), false);
});

// ---------------------------------------------------------------------------
// Filter matching + aggregation helpers
// ---------------------------------------------------------------------------

test('prefValueEntries: scalars, arrays, and JSON-stringified arrays', () => {
  assert.deepEqual(prefValueEntries('Primary'), ['Primary']);
  assert.deepEqual(prefValueEntries(['A', 'B']), ['A', 'B']);
  assert.deepEqual(prefValueEntries('["A","B"]'), ['A', 'B']);
  assert.deepEqual(prefValueEntries(null), []);
  assert.deepEqual(prefValueEntries(''), []);
  assert.deepEqual(prefValueEntries('[broken'), ['[broken']);
});

test('matchesPrefValue: eq is case-insensitive exact, contains is substring', () => {
  assert.equal(matchesPrefValue('Primary', 'eq', 'primary'), true);
  assert.equal(matchesPrefValue('Primary School', 'eq', 'primary'), false);
  assert.equal(matchesPrefValue('Primary School', 'contains', 'primary'), true);
  assert.equal(matchesPrefValue('["A","B"]', 'eq', 'b'), true);
  assert.equal(matchesPrefValue('["A","B"]', 'eq', 'c'), false);
  assert.equal(matchesPrefValue(null, 'eq', 'x'), false);
});

test('matchesColumnFilter: text and array columns', () => {
  const eventCat = STRUCTURED_ENTITIES.event;
  assert.equal(
    matchesColumnFilter(
      { location: 'Cape Town' },
      { kind: 'column', field: 'location', op: 'eq', value: 'cape town' },
      eventCat
    ),
    true
  );
  assert.equal(
    matchesColumnFilter(
      { location: 'Cape Town CBD' },
      { kind: 'column', field: 'location', op: 'contains', value: 'cape' },
      eventCat
    ),
    true
  );
  assert.equal(
    matchesColumnFilter(
      { location: null },
      { kind: 'column', field: 'location', op: 'eq', value: 'x' },
      eventCat
    ),
    false
  );

  const resCat = STRUCTURED_ENTITIES.resource;
  assert.equal(
    matchesColumnFilter(
      { subcategories: ['Funding', 'Grants'] },
      { kind: 'column', field: 'subcategories', op: 'eq', value: 'funding' },
      resCat
    ),
    true
  );
  assert.equal(
    matchesColumnFilter(
      { subcategories: '["Funding"]' },
      { kind: 'column', field: 'subcategories', op: 'eq', value: 'funding' },
      resCat
    ),
    true
  );
  assert.equal(
    matchesColumnFilter(
      { subcategories: ['Grants'] },
      { kind: 'column', field: 'subcategories', op: 'eq', value: 'funding' },
      resCat
    ),
    false
  );
});

test('groupAndCount: buckets, (not set), multi-values, truncation', () => {
  const rows = [
    { c: 'ZA' },
    { c: 'ZA' },
    { c: 'UK' },
    { c: null },
    { c: '  ' },
  ];
  const { groups, truncated } = groupAndCount(rows, (r) => r.c);
  assert.equal(truncated, false);
  assert.deepEqual(groups, [
    { value: '(not set)', count: 2 },
    { value: 'ZA', count: 2 },
    { value: 'UK', count: 1 },
  ]);

  // multi-value rows count once per distinct value
  const multi = groupAndCount([{ v: ['A', 'B', 'A'] }], (r) => r.v);
  assert.deepEqual(multi.groups, [
    { value: 'A', count: 1 },
    { value: 'B', count: 1 },
  ]);

  // truncation to MAX_GROUPS with an (other) bucket
  const many = Array.from({ length: MAX_GROUPS + 5 }, (_, i) => ({
    v: `val-${i}`,
  }));
  const t = groupAndCount(many, (r) => r.v);
  assert.equal(t.truncated, true);
  assert.equal(t.groups.length, MAX_GROUPS + 1);
  assert.equal(t.groups[t.groups.length - 1].value, '(other)');
  assert.equal(
    t.groups.reduce((s, g) => s + g.count, 0),
    MAX_GROUPS + 5
  );
});

// ---------------------------------------------------------------------------
// Routing pre-gate + planner catalog
// ---------------------------------------------------------------------------

test('looksLikeStructuredQuestion: counts yes, content no', () => {
  assert.equal(
    looksLikeStructuredQuestion('How many schools are in South Africa?'),
    true
  );
  assert.equal(
    looksLikeStructuredQuestion('how many events are running this year'),
    true
  );
  assert.equal(looksLikeStructuredQuestion('Breakdown of members per country'), true);
  assert.equal(
    looksLikeStructuredQuestion('What did the latest newsletter say?'),
    false
  );
  assert.equal(
    looksLikeStructuredQuestion('Tell me about the funding resources'),
    false
  );
});

test('buildPlannerCatalog: lists entities and scoped active custom fields only', () => {
  const catalog = buildPlannerCatalog(PREF_FIELDS);
  assert.match(catalog, /entity "organization"/);
  assert.match(catalog, /entity "booking"/);
  assert.match(catalog, /pref:pf-school-type.*School Type/);
  // member-scoped field appears under member, and inactive fields never appear
  assert.match(catalog, /pref:pf-region.*Region/);
  assert.doesNotMatch(catalog, /pf-inactive/);
});

// ---------------------------------------------------------------------------
// Task #2424: numeric aggregations (sum/avg/min/max)
// ---------------------------------------------------------------------------

test('validateQuerySpec: accepts sum/avg/min/max on a numeric field', () => {
  for (const agg of ['sum', 'avg', 'min', 'max']) {
    const r = validateQuerySpec({
      entity: 'event',
      aggregation: agg,
      field: 'available_seats',
    });
    assert.equal(r.ok, true, `${agg} should be accepted`);
    assert.equal(r.spec.aggregation, agg);
    assert.deepEqual(r.spec.field, { kind: 'column', field: 'available_seats' });
    assert.equal(r.spec.groupBy, null);
  }
  // complex_event too
  const ce = validateQuerySpec({
    entity: 'complex_event',
    aggregation: 'max',
    field: 'available_seats',
  });
  assert.equal(ce.ok, true);
});

test('validateQuerySpec: numeric aggs reject non-numeric and unknown fields', () => {
  const nonNumeric = validateQuerySpec({
    entity: 'event',
    aggregation: 'sum',
    field: 'title',
  });
  assert.equal(nonNumeric.ok, false);
  assert.match(nonNumeric.reason, /not numeric/);

  const unknown = validateQuerySpec({
    entity: 'event',
    aggregation: 'avg',
    field: 'ticket_price',
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /Unknown aggregation field/);

  const missing = validateQuerySpec({ entity: 'event', aggregation: 'sum' });
  assert.equal(missing.ok, false);

  // preference fields are never numeric-aggregable
  const pref = validateQuerySpec(
    {
      entity: 'organization',
      aggregation: 'sum',
      field: 'pref:pf-school-type',
    },
    { prefFields: PREF_FIELDS }
  );
  assert.equal(pref.ok, false);
  assert.match(pref.reason, /not numeric/);
});

test('validateQuerySpec: numeric aggs refused on aggregate-only booking entities', () => {
  for (const entity of ['booking', 'complex_event_booking']) {
    const r = validateQuerySpec({
      entity,
      aggregation: 'sum',
      field: 'event_title',
    });
    assert.equal(r.ok, false, `${entity} must refuse numeric aggregations`);
    assert.match(r.reason, /aggregate counts only/);
  }
});

test('validateQuerySpec: grouped numeric aggregation rules', () => {
  const grouped = validateQuerySpec({
    entity: 'event',
    aggregation: 'avg',
    field: 'available_seats',
    groupBy: 'event_type',
  });
  assert.equal(grouped.ok, true);
  assert.deepEqual(grouped.spec.groupBy, { kind: 'column', field: 'event_type' });

  // groupBy must still be groupable
  const notGroupable = validateQuerySpec({
    entity: 'event',
    aggregation: 'avg',
    field: 'available_seats',
    groupBy: 'title',
  });
  assert.equal(notGroupable.ok, false);
  assert.match(notGroupable.reason, /not groupable/);

  // field is reserved for numeric aggregations
  const strayField = validateQuerySpec({
    entity: 'event',
    aggregation: 'count',
    field: 'available_seats',
  });
  assert.equal(strayField.ok, false);

  // plain count still rejects groupBy
  const countGroup = validateQuerySpec({
    entity: 'event',
    aggregation: 'count',
    groupBy: 'event_type',
  });
  assert.equal(countGroup.ok, false);
});

test('computeNumericAggregate: math, null/non-numeric skipping, empty input', () => {
  const rows = [
    { n: 10 },
    { n: '20' },
    { n: null },
    { n: 'abc' },
    { n: '' },
    { n: 30 },
  ];
  const get = (r) => r.n;
  assert.deepEqual(computeNumericAggregate(rows, get, 'sum'), {
    value: 60,
    valueCount: 3,
  });
  assert.deepEqual(computeNumericAggregate(rows, get, 'avg'), {
    value: 20,
    valueCount: 3,
  });
  assert.deepEqual(computeNumericAggregate(rows, get, 'min'), {
    value: 10,
    valueCount: 3,
  });
  assert.deepEqual(computeNumericAggregate(rows, get, 'max'), {
    value: 30,
    valueCount: 3,
  });
  // zero is a real value, not "missing"
  assert.deepEqual(computeNumericAggregate([{ n: 0 }], get, 'min'), {
    value: 0,
    valueCount: 1,
  });
  // no numeric values at all -> null, never NaN or 0
  assert.deepEqual(computeNumericAggregate([{ n: null }], get, 'sum'), {
    value: null,
    valueCount: 0,
  });
  assert.deepEqual(computeNumericAggregate([], get, 'avg'), {
    value: null,
    valueCount: 0,
  });
});

test('groupAndAggregate: per-group math, (not set) bucket, sort, truncation', () => {
  const rows = [
    { type: 'Workshop', seats: 10 },
    { type: 'Workshop', seats: 30 },
    { type: 'Webinar', seats: 100 },
    { type: null, seats: 5 },
    { type: 'Gala', seats: null },
  ];
  const { groups, truncated } = groupAndAggregate(
    rows,
    (r) => r.type,
    (r) => r.seats,
    'sum'
  );
  assert.equal(truncated, false);
  assert.deepEqual(groups, [
    { value: 'Webinar', count: 1, aggregate: 100 },
    { value: 'Workshop', count: 2, aggregate: 40 },
    { value: '(not set)', count: 1, aggregate: 5 },
    { value: 'Gala', count: 1, aggregate: null }, // no value sorts last
  ]);

  const avg = groupAndAggregate(
    rows,
    (r) => r.type,
    (r) => r.seats,
    'avg'
  );
  assert.equal(avg.groups.find((g) => g.value === 'Workshop').aggregate, 20);

  // truncation keeps the top MAX_GROUPS with no (other) bucket
  const many = Array.from({ length: MAX_GROUPS + 5 }, (_, i) => ({
    type: `t-${i}`,
    seats: i,
  }));
  const t = groupAndAggregate(
    many,
    (r) => r.type,
    (r) => r.seats,
    'max'
  );
  assert.equal(t.truncated, true);
  assert.equal(t.groups.length, MAX_GROUPS);
  assert.ok(!t.groups.some((g) => g.value === '(other)'));
  // sorted desc by aggregate: the largest seat counts survive
  assert.equal(t.groups[0].aggregate, MAX_GROUPS + 4);
});

test('templateStructuredAnswer: counts, breakdowns, and numeric shapes', () => {
  // plain count (existing shape)
  assert.equal(
    templateStructuredAnswer({
      entity: 'event',
      total: 7,
      groups: null,
      truncated: false,
      appliedFilters: [],
    }),
    'There are 7 matching event records.'
  );
  // count_by breakdown (existing shape)
  const breakdown = templateStructuredAnswer({
    entity: 'organization',
    total: 3,
    groupByLabel: 'tags',
    groups: [
      { value: 'A', count: 2 },
      { value: 'B', count: 1 },
    ],
    truncated: false,
    appliedFilters: ['tags = "x"'],
  });
  assert.match(breakdown, /Breakdown by tags \(tags = "x"\) — total 3:/);
  assert.match(breakdown, /- A: 2/);

  // plain numeric
  assert.equal(
    templateStructuredAnswer({
      entity: 'event',
      aggregation: 'avg',
      field: 'available_seats',
      total: 4,
      value: 33.333333,
      valueCount: 3,
      groups: null,
      truncated: false,
      appliedFilters: [],
    }),
    'The average available seats across 3 matching event records is 33.33.'
  );
  // numeric with no values at all
  assert.match(
    templateStructuredAnswer({
      entity: 'event',
      aggregation: 'sum',
      field: 'available_seats',
      total: 2,
      value: null,
      valueCount: 0,
      groups: null,
      truncated: false,
      appliedFilters: [],
    }),
    /None of the 2 matching event records have a value for available seats\./
  );
  // grouped numeric
  const grouped = templateStructuredAnswer({
    entity: 'event',
    aggregation: 'max',
    field: 'available_seats',
    groupByLabel: 'event_type',
    total: 5,
    groups: [
      { value: 'Gala', count: 2, aggregate: 200 },
      { value: 'Webinar', count: 3, aggregate: null },
    ],
    truncated: true,
    appliedFilters: [],
  });
  assert.match(grouped, /Highest available seats by event_type:/);
  assert.match(grouped, /- Gala: 200 \(2 records\)/);
  assert.match(grouped, /- Webinar: no value \(3 records\)/);
  assert.match(grouped, /only the top groups are shown/);
});

test('planner catalog advertises numeric fields automatically', () => {
  const catalog = buildPlannerCatalog([]);
  assert.match(
    catalog,
    /available_seats \(numeric, usable with sum\/avg\/min\/max\)/
  );
});

test('looksLikeStructuredQuestion: numeric aggregation phrasings', () => {
  assert.equal(
    looksLikeStructuredQuestion('What is the average seats per event?'),
    true
  );
  assert.equal(
    looksLikeStructuredQuestion('total capacity of upcoming events'),
    true
  );
  assert.equal(
    looksLikeStructuredQuestion('which event has the largest capacity?'),
    true
  );
});
