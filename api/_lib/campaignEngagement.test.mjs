import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyCampaignEngagement as classify, trustedProviderEvent, loadCampaignEngagement } from './campaignEngagement.js';

const click = (ms, url = 'a', extra = {}) => ({
  id: `${ms}-${url}`, campaign_id: 'campaign', recipient_id: 'recipient',
  original_url: url, clicked_at: new Date(1700000000000 + ms).toISOString(),
  ip_address: '192.0.2.1', user_agent: 'fixture', ...extra,
});
test('burst classifies all participants without mutating raw evidence; later visit qualifies', () => {
  const rows = [click(0), click(100, 'b'), click(300, 'c'), click(9000)];
  const before = structuredClone(rows);
  const result = classify(rows);
  assert.equal(result.suspectedAutomatedClicks, 3);
  assert.equal(result.estimatedClicks, 1);
  assert.equal(result.estimatedClickedRecipients, 1);
  assert.deepEqual(result.events[0].classification_reasons, ['rapid_multi_link_burst']);
  assert.deepEqual(rows, before);
  assert.deepEqual(classify([...rows].reverse()).estimatedClicks, 1);
});
test('immediate single clicks, repeat visits and slower multi-link reading qualify', () => {
  for (const rows of [[click(0)], [click(0), click(1), click(2)],
    [click(0), click(1100, 'b'), click(2200, 'c')]]) {
    assert.equal(classify(rows).estimatedClicks, rows.length);
    assert.equal(classify(rows).estimatedClickedRecipients, 1);
  }
});
test('burst threshold, recipient/client isolation and missing metadata are conservative', () => {
  assert.equal(classify([click(0), click(500, 'b'), click(1000, 'c')]).estimatedClicks, 0);
  for (const extra of [{ recipient_id: 'other' }, { campaign_id: 'other' },
    { ip_address: '192.0.2.2' }, { user_agent: 'other' }, { user_agent: '' },
    { clicked_at: 'invalid' }]) {
    assert.equal(classify([click(0), click(1, 'b'), click(2, 'c', extra)]).estimatedClicks, 3);
  }
});
test('only verified supported provider indicators with exact event correlation exclude clicks', () => {
  const raw = { event: 'clicked', 'client-info': { bot: 'generic', 'user-agent': 'fixture' }, timestamp: 1700000000,
    url: 'a', ip: '192.0.2.1' };
  const provider = (data, verified = true) => [{ campaign_id: 'campaign', recipient_id: 'recipient',
    raw_event: trustedProviderEvent(data, verified) }];
  const result = classify([click(0), click(5000)], provider(raw));
  assert.equal(result.estimatedClicks, 1);
  assert.equal(result.estimatedClickedRecipients, 1);
  assert.deepEqual(result.events[0].classification_reasons, ['verified_provider_bot']);
  for (const change of [{ 'client-info': { bot: '' } }, { 'client-info': { bot: true } }, { 'client-info': { bot: 'unknown' } },
    { event: 'opened' }, { ip: '' }, { url: 'different' }, { timestamp: 1700000010 }])
    assert.equal(classify([click(0)], provider({ ...raw, ...change })).estimatedClicks, 1);
  assert.equal(classify([click(0)], provider({ ...raw, _iconnect_verified_provider: true }, false)).estimatedClicks, 1);
  const token = Buffer.from('campaign:recipient:0').toString('base64url');
  assert.equal(classify([click(0)], provider({ ...raw,
    url: `https://example.invalid/api/track/click?t=${token}&url=a` })).estimatedClicks, 0);
});
test('complete paginated evidence required, scoped to campaign and tenant', async () => {
  const calls = [];
  function db(fail = false) {
    return { from(table) {
      const filters = [];
      const q = { select() { return q; }, eq(...args) { filters.push(args); return q; },
        single() { calls.push([table, filters]); return Promise.resolve({ error: null }); },
        order() { return q; }, range(offset) {
          calls.push([table, filters]);
          return Promise.resolve(fail ? { error: new Error('unavailable') }
            : { count: table === 'email_event' ? 0 : 3,
              data: table === 'email_event' ? [] : [click(offset * 100, ['a', 'b', 'c'][offset])] });
        } };
      return q;
    } };
  }
  assert.equal((await loadCampaignEngagement(db(), 'campaign', 'tenant')).suspectedAutomatedClicks, 3);
  assert.ok(calls.every(([, filters]) => filters.some(([k, v]) => k === 'id' && v === 'campaign' || k === 'campaign_id' && v === 'campaign')));
  assert.ok(calls.filter(([t]) => t !== 'email_counted_link_click').every(([, f]) => f.some(([k, v]) => k === 'tenant_id' && v === 'tenant')));
  await assert.rejects(loadCampaignEngagement(db(true), 'campaign', 'tenant'), /unavailable/);
});

test('stats API returns estimates and dialog preserves them; audience resolution stays independent', async () => {
  const service = await readFile(new URL('./campaignService.js', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../../client/src/components/EmailCampaigns.jsx', import.meta.url), 'utf8');
  const statsStart = service.indexOf('export async function getCampaignStats(');
  const statsEnd = service.indexOf('export async function getClickHeatmapData(', statsStart);
  const audienceStart = service.indexOf('export async function getTargetRecipients(');
  assert.ok(audienceStart >= 0);
  const audienceEnd = service.indexOf('\nexport ', audienceStart + 1);
  assert.doesNotMatch(service.slice(audienceStart, audienceEnd), /loadCampaignEngagement/);
  const statsFunction = service.slice(statsStart, statsEnd).replace('export ', '');
  const fixture = { events: [], estimatedClicks: 1, estimatedClickedRecipients: 1, suspectedAutomatedClicks: 3 };
  const db = { from() {
    const q = { select() { return q; }, eq() { return q; }, gt() { return q; },
      not() { return q; }, limit() { return q; }, single() { return q; },
      then(resolve) { return Promise.resolve({ data: [], count: 4 }).then(resolve); } };
    return q;
  } };
  const getStats = new Function('supabase', 'loadCampaignEngagement',
    `${statsFunction}; return getCampaignStats;`)(db, async (_db, campaign, tenant) => {
      assert.equal(campaign, 'campaign'); assert.equal(tenant, 'tenant'); return fixture;
    });
  const result = await getStats('campaign', 'tenant');
  assert.equal(result.success, true);
  // Execute the actual dialog mapping, not a duplicate hand-written mapping.
  const viewStart = ui.indexOf('const handleViewStats =');
  const mappingStart = ui.indexOf('setStatsData({', viewStart) + 'setStatsData('.length;
  const mappingEnd = ui.indexOf('\n      });', mappingStart) + '\n      }'.length;
  const map = new Function('stats', 'campaignData', 'heatmapData',
    `return (${ui.slice(mappingStart, mappingEnd)});`);
  const mapped = map(result.stats, { name: 'fixture' }, []);
  for (const key of ['estimatedClicks', 'estimatedClickedRecipients', 'suspectedAutomatedClicks']) {
    assert.equal(result.stats[key], fixture[key]);
    assert.equal(mapped[key], fixture[key]);
    assert.equal(map({ ...result.stats, [key]: 0 }, {}, [])[key], 0);
  }
});
