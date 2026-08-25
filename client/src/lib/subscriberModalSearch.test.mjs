import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  beginExternalSubscriberRequest,
  createLatestRequestTracker,
  fetchAllExternalSubscribers,
  filterMemberSubscribers,
  getPageAfterRemoval,
  getSubscriberEmptyState,
  paginateSubscriberResults,
} from './subscriberModalSearch.js';

const members = [
  {
    id: 'm1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ADA@EXAMPLE.ORG',
    organization_id: 'org1',
    role_id: 'role1',
  },
  {
    id: 'm2',
    first_name: 'Grace',
    last_name: 'Hopper',
    email: 'grace@example.org',
    organization_id: 'org2',
    role_id: 'role2',
  },
];

const orgLookup = { org1: 'Analytical Engines Ltd', org2: 'US Navy' };
const roleLookup = { role1: 'Board Member', role2: 'Admiral' };

test('member search matches displayed name, email, organisation, and role case-insensitively', () => {
  for (const search of ['ADA LOVELACE', 'ada@example', 'analytical ENGINES', 'board MEMBER']) {
    assert.deepEqual(
      filterMemberSubscribers(members, search, orgLookup, roleLookup).map((member) => member.id),
      ['m1'],
      search
    );
  }
});

test('member search filters the complete collection before pagination and clearing restores it', () => {
  const collection = Array.from({ length: 24 }, (_, index) => ({
    id: `m${index + 1}`,
    first_name: index === 20 ? 'Needle' : 'Member',
    last_name: `${index + 1}`,
    email: `member${index + 1}@example.org`,
  }));

  const filteredPage = paginateSubscriberResults(
    filterMemberSubscribers(collection, 'needle'),
    2,
    10
  );
  assert.equal(filteredPage.total, 1);
  assert.equal(filteredPage.currentPage, 1);
  assert.equal(filteredPage.items[0].id, 'm21');

  const clearedPage = paginateSubscriberResults(
    filterMemberSubscribers(collection, '   '),
    1,
    10
  );
  assert.equal(clearedPage.total, 24);
  assert.equal(clearedPage.items.length, 10);
});

test('empty category and search-with-no-matches remain distinct', () => {
  assert.equal(getSubscriberEmptyState(0, 0, ''), 'empty');
  assert.equal(getSubscriberEmptyState(2, 0, 'missing'), 'no-match');
  assert.equal(getSubscriberEmptyState(2, 2, ''), null);
});

test('pagination reports safe filtered ranges and deletion recovers an emptied last page', () => {
  const page = paginateSubscriberResults(Array.from({ length: 11 }, (_, id) => ({ id })), 2, 10);
  assert.deepEqual(
    { currentPage: page.currentPage, totalPages: page.totalPages, start: page.rangeStart, end: page.rangeEnd },
    { currentPage: 2, totalPages: 2, start: 11, end: 11 }
  );
  assert.equal(getPageAfterRemoval(2, 11, 10), 1);
  assert.equal(getPageAfterRemoval(2, 12, 10), 2);
});

test('deletion recovery follows a newer requested page instead of an older resolved page', () => {
  const deletingFromPageTwo = {
    externalPage: 2,
    externalSearch: 'ada',
    externalTotal: 25,
    externalActionGeneration: 4,
  };
  const afterNextPageClick = beginExternalSubscriberRequest(
    deletingFromPageTwo,
    3,
    'ada'
  );

  assert.equal(afterNextPageClick.externalPage, 3);
  assert.equal(afterNextPageClick.externalActionGeneration, 5);
  assert.equal(
    getPageAfterRemoval(
      afterNextPageClick.externalPage,
      afterNextPageClick.externalTotal,
      10
    ),
    3
  );
});

test('latest-request tracker rejects a response after a newer request or invalidation', () => {
  const tracker = createLatestRequestTracker();
  const first = tracker.begin();
  const second = tracker.begin();
  assert.equal(tracker.isLatest(first), false);
  assert.equal(tracker.isLatest(second), true);
  tracker.invalidate();
  assert.equal(tracker.isLatest(second), false);
});

test('subscriber modal wiring resets searches and pages, and keeps recoverable no-match states', () => {
  const source = readFileSync(
    new URL('../pages/CommunicationsManagement.jsx', import.meta.url),
    'utf8'
  );
  const openHandler = source.slice(
    source.indexOf('const openSubscribersView'),
    source.indexOf('const getPaginatedSubscribers')
  );

  assert.match(openHandler, /setMemberSearch\(''\)/);
  assert.match(openHandler, /setExternalSearch\(''\)/);
  assert.match(openHandler, /setSubscribersPage\(1\)/);
  assert.match(openHandler, /setExternalSubscribersPage\(1\)/);
  assert.match(source, /setMemberSearch\(event\.target\.value\);\s*setSubscribersPage\(1\)/);
  assert.match(source, /setExternalSearch\(nextSearch\)/);
  assert.match(source, /setExternalSubscribersPage\(1\)/);
  assert.match(source, /No member subscribers match your search/);
  assert.match(source, /No external subscribers match your search/);
  assert.match(source, /button-retry-external-subscribers/);
  assert.match(source, /currentContext\.generation === deleteContext\.generation/);
});

test('external export follows every server page instead of truncating large categories', async () => {
  const requestedPages = [];
  const rows = Array.from({ length: 205 }, (_, index) => ({ id: `s${index + 1}` }));
  const subscribers = await fetchAllExternalSubscribers({
    categoryId: 'category-1',
    pageSize: 100,
    fetchImpl: async (url) => {
      const parsed = new URL(url, 'https://example.test');
      const page = Number(parsed.searchParams.get('page'));
      const perPage = Number(parsed.searchParams.get('per_page'));
      requestedPages.push(page);
      const start = (page - 1) * perPage;
      return {
        ok: true,
        json: async () => ({
          subscribers: rows.slice(start, start + perPage),
          total: rows.length,
        }),
      };
    },
  });

  assert.deepEqual(requestedPages, [1, 2, 3]);
  assert.equal(subscribers.length, 205);
  assert.equal(subscribers.at(-1).id, 's205');
});