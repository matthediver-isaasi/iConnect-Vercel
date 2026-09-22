import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCommunicationStatusReportRow,
  communicationCategoryAvailability,
  parseCommunicationStatusReportFilters,
} from './memberCommunicationStatusReport.js';

test('report filters are bounded and category status requires a category', () => {
  assert.deepEqual(parseCommunicationStatusReportFilters({
    page: '-2',
    limit: '10000',
    globalOptOut: 'yes',
    categoryStatus: 'opted_in',
  }), {
    page: 1,
    limit: 100,
    search: '',
    organizationId: '',
    roleId: '',
    globalOptOut: 'yes',
    categoryId: '',
    categoryStatus: '',
  });
});

test('missing and explicit false preferences are not opted in while true is opted in', () => {
  const categories = [
    { id: 'a', is_active: true, member_enabled: true },
    { id: 'b', is_active: true, member_enabled: true },
    { id: 'c', is_active: true, member_enabled: true },
  ];
  const row = buildCommunicationStatusReportRow(
    {
      id: 'member-1',
      role_id: 'role-1',
      communications_opted_out_all: true,
    },
    categories,
    [
      { category_id: 'b', is_subscribed: false },
      { category_id: 'c', is_subscribed: true },
    ],
    new Map(),
  );
  assert.equal(row.categoryStatuses.a.optedIn, false);
  assert.equal(row.categoryStatuses.b.optedIn, false);
  assert.equal(row.categoryStatuses.c.optedIn, true);
  assert.equal(row.globalOptOut, true, 'global suppression remains separate from stored opt-ins');
});

test('eligibility marks inactive, public-only and role-restricted categories unavailable', () => {
  assert.deepEqual(
    communicationCategoryAvailability({}, { is_active: false }, []),
    { available: false, reason: 'inactive' },
  );
  assert.deepEqual(
    communicationCategoryAvailability({}, { is_active: true, member_enabled: false }, []),
    { available: false, reason: 'public_only' },
  );
  assert.deepEqual(
    communicationCategoryAvailability(
      { role_id: 'other' },
      { is_active: true, member_enabled: true },
      ['eligible'],
    ),
    { available: false, reason: 'role_ineligible' },
  );
});

test('eligibility supports members with multiple role ids through the shared helper', () => {
  assert.deepEqual(
    communicationCategoryAvailability(
      { role_id: ['other', 'eligible'] },
      { is_active: true, member_enabled: true },
      ['eligible'],
    ),
    { available: true, reason: null },
  );
});