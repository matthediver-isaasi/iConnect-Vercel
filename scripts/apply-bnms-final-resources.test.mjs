import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVED_RESOURCE_TYPES,
  prepareApprovedReport,
  planApproved,
  resourceId,
} from './apply-bnms-final-resources.mjs';
import {
  HEADERS,
  TENANT_ID,
  buildReport,
} from './bnms-final-resources-proposal.mjs';

function categories() {
  return [
    {
      id: 'collection',
      name: 'Collection',
      tenant_id: TENANT_ID,
      subcategories: ['Events'],
      description: null,
      display_order: 1,
      is_active: true,
      applies_to_content_types: null,
      excluded_role_ids: [],
      subcategory_excluded_role_ids: {},
    },
    {
      id: 'resource-type',
      name: 'Resource Type',
      tenant_id: TENANT_ID,
      subcategories: ['Guidelines'],
      description: null,
      display_order: 2,
      is_active: true,
      applies_to_content_types: null,
      excluded_role_ids: ['role'],
      subcategory_excluded_role_ids: { Guidelines: ['role'] },
    },
    {
      id: 'focus',
      name: 'Focus Area',
      tenant_id: TENANT_ID,
      subcategories: ['Radiopharmacy'],
      description: null,
      display_order: 3,
      is_active: true,
      applies_to_content_types: null,
      excluded_role_ids: [],
      subcategory_excluded_role_ids: {},
    },
  ];
}

function source({
  memberOnly = 'Yes',
  resourceType = 'NM Images',
  title = 'Synthetic',
  url = 'https://example.org/synthetic',
} = {}) {
  const result = Object.fromEntries(HEADERS.map((header) => [header, '']));
  Object.assign(result, {
    'Resource URL': url,
    Title: title,
    'Brief Description': 'Description',
    Date: '2025',
    'Member Only': memberOnly,
    Collection: 'Events',
    'Resource Type': resourceType,
  });
  return result;
}

function workbook(rows) {
  return {
    checksum: 'synthetic-approval-checksum',
    headers: HEADERS,
    sheets: [],
    rows: rows.map((row, index) => ({
      row: index + 2,
      source: row,
      hyperlinks: [],
      formulas: [],
    })),
  };
}

function resource(id, extra = {}) {
  return {
    id,
    tenant_id: TENANT_ID,
    title: 'Existing',
    description: 'Existing description',
    subcategories: ['Events', 'Guidelines'],
    resource_type: 'external_link',
    target_url: `https://example.org/${id}`,
    open_in_new_tab: true,
    image_url: null,
    release_date: null,
    is_public: true,
    allowed_role_ids: [],
    tags: ['keep'],
    author_id: null,
    author_name: null,
    folder_id: null,
    status: 'active',
    search_text: null,
    linked_events: [],
    seo_title: null,
    seo_description: null,
    og_image_url: null,
    is_sample: false,
    member_group_id: null,
    ...extra,
  };
}

test('approved planner adds exactly four Resource Type values and holds access changes', () => {
  const sourceRows = [
    source({ resourceType: 'NM Images' }),
    source({
      resourceType: 'Guidelines',
      title: 'Access must remain held',
      memberOnly: 'Yes',
      url: 'https://example.org/does-not-match',
    }),
  ];
  const existing = resource('existing', {
    target_url: 'https://example.org/does-not-match',
    title: 'Access must remain held',
    is_public: true,
  });
  const beforeCategories = categories();
  const before = {
    tenant: { id: TENANT_ID, name: 'BNMS' },
    resources: [existing],
    categories: beforeCategories,
  };
  const prepared = prepareApprovedReport(
    workbook(sourceRows),
    before.resources,
    before.categories,
  );
  assert.deepEqual(
    prepared.afterCategories.find((category) => category.name === 'Resource Type').subcategories,
    ['Guidelines', ...APPROVED_RESOURCE_TYPES],
  );
  // The second row has no URL identity and a title-only coincidence, so it
  // remains held independently of the taxonomy approval. This test also
  // verifies the access-hold issue cannot be relaxed by taxonomy additions.
  assert.ok(prepared.report.rows.every((row) => row.status === 'insert' || row.status === 'blocked'));
  const bundle = {
    report: prepared.report,
    before,
    afterCategories: prepared.afterCategories,
  };
  const plan = planApproved(bundle);
  assert.equal(plan.inserts.length, 1);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.summary.blocked, 1);
  assert.ok(plan.skipped.some((row) => row.issues.includes('approved_access_change_held')));
  assert.equal(plan.categoryUpdates.length, 1);
  assert.deepEqual(plan.categoryUpdates[0].before.subcategory_excluded_role_ids, {
    Guidelines: ['role'],
  });
});

test('resource IDs are deterministic and tenant/source-row scoped', () => {
  assert.equal(resourceId(2), resourceId(2));
  assert.notEqual(resourceId(2), resourceId(3));
  assert.notEqual(resourceId(2, 'different-source'), resourceId(2));
  assert.match(resourceId(2), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('unapproved taxonomy values stop the approved planner', () => {
  const bad = source({ resourceType: 'Unapproved type' });
  const wb = workbook([bad]);
  const cats = categories();
  assert.throws(
    () => prepareApprovedReport(wb, [], cats),
    /unapproved missing taxonomy value/i,
  );
  // Keep a direct build assertion here so this test documents the source
  // issue rather than relying on the planner's error text alone.
  const report = buildReport(wb, [], cats);
  assert.ok(report.missingTaxonomy.includes('missing_taxonomy:Resource Type:Unapproved type'));
});