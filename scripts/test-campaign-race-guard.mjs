/**
 * Regression test for the sendCampaign() / processSendingCampaigns() race
 * fix. This is the scenario from incident: a campaign is in status='sending'
 * with total_recipients > 0 but the recipient rows have not been inserted
 * yet (sendCampaign is mid-resolve). The cron worker MUST NOT mark such a
 * campaign as 'sent'.
 *
 * Run:
 *   node scripts/test-campaign-race-guard.mjs
 *
 * Exits non-zero on any failed assertion.
 */

import { shouldMarkCampaignSent } from '../api/_lib/campaignService.js';

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failures += 1;
  }
}

console.log('shouldMarkCampaignSent — race-condition regression tests');

// THE BUG SCENARIO: status='sending', total_recipients>0, but zero rows in
// email_campaign_recipient yet (sendCampaign is in the middle of audience
// resolution). The cron must NOT mark this 'sent'.
assert(
  shouldMarkCampaignSent({ pendingCount: 0, processingCount: 0, anyRowCount: 0 }) === false,
  'race scenario: zero pending, zero processing, zero rows → must NOT mark sent'
);

// Legitimate completion: rows exist, none pending or processing.
assert(
  shouldMarkCampaignSent({ pendingCount: 0, processingCount: 0, anyRowCount: 4820 }) === true,
  'completion scenario: zero pending+processing AND rows exist → mark sent'
);

// Legitimate completion with only failed/bounced/cancelled rows (still rows).
assert(
  shouldMarkCampaignSent({ pendingCount: 0, processingCount: 0, anyRowCount: 5 }) === true,
  'completion scenario: only failed-ish rows → mark sent'
);

// Mid-send: pending recipients still exist.
assert(
  shouldMarkCampaignSent({ pendingCount: 1, processingCount: 0, anyRowCount: 4820 }) === false,
  'mid-send: pending>0 → must NOT mark sent'
);

// Mid-send: processing recipients still exist.
assert(
  shouldMarkCampaignSent({ pendingCount: 0, processingCount: 1, anyRowCount: 4820 }) === false,
  'mid-send: processing>0 → must NOT mark sent'
);

// Both pending and processing.
assert(
  shouldMarkCampaignSent({ pendingCount: 100, processingCount: 100, anyRowCount: 4820 }) === false,
  'mid-send: pending>0 and processing>0 → must NOT mark sent'
);

// Defensive: nullish counts should be treated as zero.
assert(
  shouldMarkCampaignSent({ pendingCount: null, processingCount: undefined, anyRowCount: 1 }) === true,
  'defensive: nullish counts → treat as zero'
);
assert(
  shouldMarkCampaignSent({ pendingCount: null, processingCount: null, anyRowCount: null }) === false,
  'defensive: all nullish → must NOT mark sent'
);

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll race-guard tests passed.');
