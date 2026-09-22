import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('campaign enrichment and completed badge use the exact failed recipient count', async () => {
  const [serviceSource, uiSource] = await Promise.all([
    readFile(new URL('./campaignService.js', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/components/EmailCampaigns.jsx', import.meta.url), 'utf8'),
  ]);

  const enrichStart = serviceSource.indexOf('async function enrichCampaignCounts');
  const enrichEnd = serviceSource.indexOf('export async function getCampaigns', enrichStart);
  assert.ok(enrichStart >= 0 && enrichEnd > enrichStart);
  const enrichSource = serviceSource.slice(enrichStart, enrichEnd);

  assert.match(enrichSource, /\.eq\('campaign_id', campaign\.id\)\.eq\('status', 'failed'\)/);
  assert.match(enrichSource, /if \(failedResult\.error\) throw failedResult\.error/);
  assert.match(enrichSource, /failed_count: liveFailedCount/);

  const countStart = uiSource.indexOf('const completedFailureCount');
  const countEnd = uiSource.indexOf('return (', countStart);
  assert.ok(countStart >= 0 && countEnd > countStart);
  const completedCountSource = uiSource.slice(countStart, countEnd);

  assert.match(completedCountSource, /campaign\.failed_count \|\| 0/);
  assert.doesNotMatch(completedCountSource, /total_recipients|sent_count|pending_count|Math\.max/);
});