import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignAudienceFeedback } from './campaignAudienceFeedback.js';

test('aggregate feedback distinguishes no matches from consent exclusions', () => {
  assert.equal(campaignAudienceFeedback(null), null);
  assert.equal(campaignAudienceFeedback({ finalCount: 2 }), null);
  assert.match(campaignAudienceFeedback({ finalCount: 0, totalAudience: 0 }), /No contacts matched/);
  assert.match(campaignAudienceFeedback({
    finalCount: 0, totalAudience: 6, globalOptOuts: 1, categoryOptOuts: 5,
  }), /6 matching contacts: 1 excluded by global consent and 5 by category eligibility/);
});
