import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichCampaignPreparationList } from './campaignPreparationList.js';

test('list preparation errors are scoped to the current tenant and campaign generation', async () => {
  const queries = [];
  const db = {
    from(table) {
      assert.equal(table, 'campaign_preparation');
      return {
        select(columns) {
          assert.equal(columns, 'id,campaign_id,phase,last_error');
          return this;
        },
        eq(column, value) {
          queries.push([column, value]);
          return this;
        },
        in(column, values) {
          queries.push([column, values]);
          return Promise.resolve({ data: [
            { id: 'generation-1', campaign_id: 'campaign-1', phase: 'failed', last_error: 'Audience quota exceeded' },
            { id: 'generation-2', campaign_id: 'different-campaign', phase: 'failed', last_error: 'Never expose this' },
            { id: 'generation-3', campaign_id: 'campaign-3', phase: 'insert', last_error: 'Historical transient error' },
          ], error: null });
        },
      };
    },
  };
  const campaigns = [
    { id: 'campaign-1', status: 'failed', preparation_generation: 'generation-1' },
    { id: 'campaign-2', status: 'failed', preparation_generation: 'generation-2' },
    { id: 'campaign-3', status: 'preparing', preparation_generation: 'generation-3' },
    { id: 'campaign-4', status: 'sent', preparation_generation: 'generation-4' },
  ];
  const enriched = await enrichCampaignPreparationList(db, 'tenant-1', campaigns);
  assert.deepEqual(queries, [
    ['tenant_id', 'tenant-1'],
    ['id', ['generation-1', 'generation-2', 'generation-3']],
  ]);
  assert.deepEqual(enriched[0].preparation, { phase: 'failed', last_error: 'Audience quota exceeded' });
  assert.equal(enriched[1].preparation, undefined);
  assert.deepEqual(enriched[2].preparation, { phase: 'insert', last_error: null });
  assert.equal(enriched[3].preparation, undefined);
});