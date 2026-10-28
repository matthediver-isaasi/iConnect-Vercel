import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDownloadCampaignPdf, campaignPdfFilename } from './campaignPdfEligibility.js';

test('eligibility separates delivery from preparation and schedule evidence', () => {
  for (const status of ['sending', 'sent']) assert.equal(canDownloadCampaignPdf({ status }), true);
  for (const status of ['draft', 'scheduled', 'preparing']) {
    assert.equal(canDownloadCampaignPdf({ status, sent_at: '2026-01-01', preparation: { phase: 'complete' } }), false);
  }
  for (const status of ['paused', 'failed', 'cancelled']) {
    assert.equal(canDownloadCampaignPdf({ status }), false);
    assert.equal(canDownloadCampaignPdf({ status, sent_at: '2026-01-01', preparation_generation: 'prep', preparation: { phase: 'failed' }, failed_count: 2, pending_count: 100 }), false);
    for (const evidence of [{ sent_count: 1 }, { delivery_summary: { sent: 1 } }, { sent_at: '2026-01-01' }, { preparation: { phase: 'complete' } }]) {
      assert.equal(canDownloadCampaignPdf({ status, archived_at: '2026-01-02', ...evidence }), true);
    }
  }
});
test('filenames are meaningful, bounded and filesystem safe', () => {
  assert.equal(campaignPdfFilename({ name: '../Spring: news?', id: '123' }), 'campaign-Spring-news-123.pdf');
  assert.match(campaignPdfFilename({}), /^campaign-email-export.pdf$/);
  assert.ok(campaignPdfFilename({ name: 'x'.repeat(500) }).length < 150);
});
