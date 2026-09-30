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
import {
  filterExplicitCategorySubscribers,
  getExplicitlySubscribedMemberIds,
  getToggledExplicitSubscriptionValue,
  mergeExternalCategorySubscribers,
} from '../../../shared/communicationCategoryMembership.js';

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
  assert.match(source, /const \[optOutPage, setOptOutPage\] = useState\(1\)/);
  assert.doesNotMatch(source, /\b(?:optedOutPage|setOptedOutPage)\b/);
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

test('explicit preferences populate roleless categories and include subscribers outside assigned roles', () => {
  const categoryMembers = [
    { id: 'inside-role', email: 'inside@example.org', role_id: 'assigned', login_enabled: true },
    { id: 'outside-role', email: 'outside@example.org', role_id: 'other', login_enabled: true },
  ];
  const preferences = categoryMembers.map(({ id }) => ({
    member_id: id,
    category_id: 'roleless-newsletter',
    is_subscribed: true,
  }));

  assert.deepEqual(
    filterExplicitCategorySubscribers(
      categoryMembers,
      preferences,
      ['roleless-newsletter']
    ).map(({ id }) => id),
    ['inside-role', 'outside-role']
  );
});

test('the first toggle on a missing explicit preference subscribes the member', () => {
  assert.equal(getToggledExplicitSubscriptionValue(undefined), true);
  assert.equal(getToggledExplicitSubscriptionValue({ is_subscribed: false }), true);
  assert.equal(getToggledExplicitSubscriptionValue({ is_subscribed: true }), false);

  const preferenceApiSource = readFileSync(
    new URL('../../../api/email-preferences/index.js', import.meta.url),
    'utf8'
  );
  assert.match(
    preferenceApiSource,
    /getToggledExplicitSubscriptionValue\(existingPref\?\.\[0\]\)/
  );
  assert.match(
    preferenceApiSource,
    /\.eq\('tenant_id', tenantId\)\s*\.eq\('member_id', member\.id\)/
  );
});

test('category membership excludes missing and false preferences, global opt-outs, inactive and deleted members', () => {
  const categoryMembers = [
    { id: 'subscribed', email: 'yes@example.org', login_enabled: true },
    { id: 'missing', email: 'missing@example.org', login_enabled: true },
    { id: 'false', email: 'false@example.org', login_enabled: true },
    { id: 'global', email: 'global@example.org', login_enabled: true, communications_opted_out_all: true },
    { id: 'inactive', email: 'inactive@example.org', login_enabled: false },
    { id: 'deleted', email: 'deleted_123@deleted.local', login_enabled: true },
  ];
  const preferences = [
    { member_id: 'subscribed', category_id: 'news', is_subscribed: true },
    { member_id: 'false', category_id: 'news', is_subscribed: false },
    { member_id: 'global', category_id: 'news', is_subscribed: true },
    { member_id: 'inactive', category_id: 'news', is_subscribed: true },
    { member_id: 'deleted', category_id: 'news', is_subscribed: true },
  ];

  assert.deepEqual(
    filterExplicitCategorySubscribers(categoryMembers, preferences, ['news']).map(({ id }) => id),
    ['subscribed']
  );
});

test('campaign opt-out bypass can retain a globally opted-out subscriber but never an inactive member', () => {
  const members = [
    { id: 'global', email: 'global@example.org', login_enabled: true, communications_opted_out_all: true },
    { id: 'inactive', email: 'inactive@example.org', login_enabled: false },
  ];
  const preferences = members.map(({ id }) => ({
    member_id: id,
    category_id: 'news',
    is_subscribed: true,
  }));

  assert.deepEqual(
    filterExplicitCategorySubscribers(
      members,
      preferences,
      ['news'],
      { includeGlobalOptOuts: true }
    ).map(({ id }) => id),
    ['global']
  );
});

test('explicit category membership deduplicates members across roles, categories, and repeated rows', () => {
  const preferences = [
    { member_id: 'member-1', category_id: 'news', is_subscribed: true },
    { member_id: 'member-1', category_id: 'news', is_subscribed: true },
    { member_id: 'member-1', category_id: 'events', is_subscribed: true },
  ];
  const membersWithDuplicateCandidate = [
    { id: 'member-1', email: 'member@example.org', login_enabled: true },
    { id: 'member-1', email: 'member@example.org', login_enabled: true },
  ];

  assert.deepEqual(
    [...getExplicitlySubscribedMemberIds(preferences, ['news', 'events'])],
    ['member-1']
  );
  assert.equal(
    filterExplicitCategorySubscribers(
      membersWithDuplicateCandidate,
      preferences,
      ['news', 'events']
    ).length,
    1
  );
});

test('external category rows cannot bypass a tenant member preference or duplicate an email', () => {
  const memberSubscribers = [
    { id: 'member-true', email: 'true@example.org' },
  ];
  const tenantMembers = [
    { id: 'member-true', email: 'true@example.org' },
    { id: 'member-false', email: 'FALSE@example.org' },
    { id: 'member-missing', email: 'missing@example.org' },
  ];
  const externalSubscribers = [
    { id: 'stale-true', email: 'TRUE@example.org' },
    { id: 'stale-false', email: 'false@example.org' },
    { id: 'stale-missing', email: 'missing@example.org' },
    { id: 'external', email: 'external@example.org', first_name: 'External' },
    { id: 'external-duplicate', email: 'EXTERNAL@example.org' },
  ];

  assert.deepEqual(
    mergeExternalCategorySubscribers(
      memberSubscribers,
      externalSubscribers,
      tenantMembers
    ).map(({ id }) => id),
    ['member-true', 'external']
  );
});

test('campaign, admin, and Zoho paths all use explicit-true subscription semantics', () => {
  const campaignSource = readFileSync(
    new URL('../../../api/_lib/campaignService.js', import.meta.url),
    'utf8'
  );
  const zohoSource = readFileSync(
    new URL('../../../api/zoho-campaigns/sync.js', import.meta.url),
    'utf8'
  );
  const zohoJobSource = readFileSync(
    new URL('../../../api/zoho-campaigns/sync-job.js', import.meta.url),
    'utf8'
  );

  assert.match(campaignSource, /filterExplicitCategorySubscribers/);
  assert.match(campaignSource, /mergeExternalCategorySubscribers/);
  assert.match(campaignSource, /if \(filters\.throwOnError\) throw error/);
  assert.match(campaignSource, /\{ memberIds, throwOnError: true \}/);
  assert.match(
    campaignSource,
    /targetType === 'form'[\s\S]*recipients = await getExplicitCategoryMemberRecipients\(categoryIds, tenantId\)/
  );
  assert.match(campaignSource, /\.order\('id', \{ ascending: true \}\)\s*\.range\(extOffset/);
  assert.match(campaignSource, /\.eq\('is_subscribed', true\)/);
  assert.match(campaignSource, /\.eq\('tenant_id', tenantId\)\s*\.eq\('category_id', communicationCategoryId\)/);
  assert.doesNotMatch(zohoSource, /pref\?\.is_subscribed !== false/);
  assert.doesNotMatch(zohoJobSource, /pref\?\.is_subscribed !== false/);
  assert.match(zohoSource, /pref\?\.is_subscribed === true/);
  assert.match(zohoJobSource, /pref\?\.is_subscribed === true/);
  assert.match(
    readFileSync(new URL('../pages/CommunicationsManagement.jsx', import.meta.url), 'utf8'),
    /MemberCommunicationPreference\.listAll\(\{\s*sort: \{ id: 'asc' \}/
  );
  assert.match(
    readFileSync(new URL('../pages/CommunicationsManagement.jsx', import.meta.url), 'utf8'),
    /Member\.listAll\(\{\s*sort: \{ id: 'asc' \}/
  );
});