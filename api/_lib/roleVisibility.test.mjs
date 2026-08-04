// Task #3349: DB-aware role access enforcement (server side).
//
// The role_access_item DB tree can place items under different modules than
// the generated hierarchy (e.g. events.discount-codes under "commerce").
// These tests verify union matching: exclusions match via the hardcoded map
// OR the DB overlay, never lose existing matches, and fall back cleanly when
// the table is empty.
process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME = '1';

import test from 'node:test';
import assert from 'node:assert/strict';

const { isResourceExcluded, __setRoleAccessOverlayForTests, buildRoleAccessOverlay } =
  await import('./roleVisibility.js');

// Mirrors the production DEST tenant tree: Discount Codes and Pending
// Purchase Orders Report are PAGE rows placed under the "commerce" module,
// while their item_key stays events.*.
const DB_ROWS = [
  { id: 'm-commerce', item_type: 'module', item_key: 'commerce', parent_id: null, is_active: true },
  { id: 'm-events', item_type: 'module', item_key: 'events', parent_id: null, is_active: true },
  { id: 'p-discount', item_type: 'page', item_key: 'events.discount-codes', parent_id: 'm-commerce', is_active: true },
  { id: 'p-ppo', item_type: 'page', item_key: 'events.pending-purchase-orders', parent_id: 'm-commerce', is_active: true },
  { id: 'p-browse', item_type: 'page', item_key: 'events.browse-events', parent_id: 'm-events', is_active: true },
  { id: 'f-create', item_type: 'feature', item_key: 'events.browse-events.create', parent_id: 'p-browse', is_active: true },
  // A legacy-keyed row must alias to its canonical id.
  { id: 'p-legacy', item_type: 'page', item_key: 'page_TicketSalesAnalytics', parent_id: 'm-commerce', is_active: true },
];

test('empty role_access_item table falls back to hardcoded hierarchy', () => {
  __setRoleAccessOverlayForTests([]);
  assert.equal(isResourceExcluded(['events'], 'events.discount-codes'), true);
  assert.equal(isResourceExcluded(['commerce'], 'events.discount-codes'), false);
});

test('module exclusion hides children as placed in the DB tree', () => {
  __setRoleAccessOverlayForTests(DB_ROWS);
  // Reported case: all Commerce & Finance controls disabled must hide
  // Discount Codes and Pending Purchase Orders Report.
  assert.equal(isResourceExcluded(['commerce'], 'events.discount-codes'), true);
  assert.equal(isResourceExcluded(['commerce'], 'events.pending-purchase-orders'), true);
  assert.equal(isResourceExcluded(['commerce'], 'page_DiscountCodeManagement'), true);
  assert.equal(isResourceExcluded(['commerce'], 'page_PendingPurchaseOrdersReport'), true);
  // Items under other modules stay visible.
  assert.equal(isResourceExcluded(['commerce'], 'events.browse-events'), false);
});

test('union: hardcoded-map placement still matches with overlay installed', () => {
  __setRoleAccessOverlayForTests(DB_ROWS);
  // Legacy exclusions stored under the old canonical placement must keep
  // matching (no access widening).
  assert.equal(isResourceExcluded(['events'], 'events.discount-codes'), true);
  assert.equal(isResourceExcluded(['events.discount-codes'], 'events.discount-codes'), true);
  assert.equal(isResourceExcluded(['page_DiscountCodeManagement'], 'events.discount-codes'), true);
});

test('DB feature rows resolve page and module parents from the tree', () => {
  __setRoleAccessOverlayForTests(DB_ROWS);
  assert.equal(isResourceExcluded(['events.browse-events'], 'events.browse-events.create'), true);
  assert.equal(isResourceExcluded(['events'], 'events.browse-events.create'), true);
});

test('legacy-keyed DB rows alias to canonical ids', () => {
  __setRoleAccessOverlayForTests(DB_ROWS);
  // Row keyed page_TicketSalesAnalytics under commerce: excluding commerce
  // hides events.ticket-analytics (and vice-versa key forms).
  assert.equal(isResourceExcluded(['commerce'], 'events.ticket-analytics'), true);
  assert.equal(isResourceExcluded(['commerce'], 'page_TicketSalesAnalytics'), true);
});

test('full AHECS-style exclusion list hides the reported nav items', () => {
  __setRoleAccessOverlayForTests(DB_ROWS);
  const ahecs = ['organisation', 'forms', 'crm', 'membership', 'commerce', 'content', 'jobs',
    'site-builder', 'support', 'communication', 'admin', 'system', 'fundraising', 'forum'];
  assert.equal(isResourceExcluded(ahecs, 'page_DiscountCodeManagement'), true);
  assert.equal(isResourceExcluded(ahecs, 'page_PendingPurchaseOrdersReport'), true);
  // Events module is NOT excluded, so events-placed pages remain visible.
  assert.equal(isResourceExcluded(ahecs, 'events.browse-events'), false);
});

test('inactive rows are ignored when building the overlay', () => {
  const overlay = buildRoleAccessOverlay([
    { id: 'm1', item_type: 'module', item_key: 'commerce', parent_id: null, is_active: true },
    { id: 'p1', item_type: 'page', item_key: 'events.discount-codes', parent_id: 'm1', is_active: false },
  ]);
  assert.equal(overlay.resourceToModule.has('events.discount-codes'), false);
});

test('buildRoleAccessOverlay returns null for empty input', () => {
  assert.equal(buildRoleAccessOverlay([]), null);
  assert.equal(buildRoleAccessOverlay(null), null);
});
