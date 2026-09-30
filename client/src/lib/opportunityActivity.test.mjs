import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpportunityQuery,
  getOpportunitiesFromResponse,
  getOpportunityActivityFromResponse,
  mergeOpportunityActivity,
  responseIncludesOpportunityActivity,
} from './opportunityActivity.js';

test('normalizes paginated opportunity responses', () => {
  assert.deepEqual(getOpportunitiesFromResponse({ items: [{ id: 'one' }] }), [{ id: 'one' }]);
  assert.deepEqual(getOpportunitiesFromResponse([{ id: 'two' }]), [{ id: 'two' }]);
});

test('extracts nested activity without copying opportunity records', () => {
  const response = {
    opportunities: [{ id: 'opp-1', name: 'Renewal', activity: [{ id: 'act-1', action: 'Created' }] }],
  };
  assert.equal(responseIncludesOpportunityActivity(response), true);
  assert.deepEqual(getOpportunityActivityFromResponse(response), [{
    id: 'act-1',
    action: 'Created',
    opportunityId: 'opp-1',
    opportunityName: 'Renewal',
  }]);
});

test('deduplicates and orders sales activity newest first', () => {
  const merged = mergeOpportunityActivity(
    [{ id: 'old', created_at: '2024-01-01T00:00:00Z' }],
    [
      { id: 'new', created_at: '2024-02-01T00:00:00Z' },
      { id: 'old', created_at: '2024-01-01T00:00:00Z' },
    ],
  );
  assert.deepEqual(merged.map((item) => item.id), ['new', 'old']);
});

test('uses contactMemberId for lists and memberId for activity', () => {
  assert.equal(
    buildOpportunityQuery({ memberId: 'member 1' }),
    '/api/opportunities?contactMemberId=member+1&page=1&pageSize=20',
  );
  assert.equal(
    buildOpportunityQuery({ memberId: 'member 1', activity: true }),
    '/api/opportunities/activity?memberId=member+1',
  );
});