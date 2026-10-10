// Reporting only: never changes raw evidence, delivery state or consent.
export const ENGAGEMENT_VERSION = 'conservative-v1';
export function trustedProviderEvent(event, verified) {
  // Always overwrite incoming metadata; an unsigned payload cannot assert trust.
  return { ...event, _iconnect_verified_provider: verified === true };
}

export function classifyCampaignEngagement(requests, providerEvents = []) {
  const events = requests.map(row => ({ ...row, suspected_automated: false,
    classification_reasons: [], classification_version: ENGAGEMENT_VERSION }));
  const time = row => Date.parse(row.clicked_at || row.created_at);
  const groups = new Map();
  for (const row of events) {
    if (!row.recipient_id || !row.ip_address || !row.user_agent || !Number.isFinite(time(row))) continue;
    const key = JSON.stringify([row.campaign_id, row.recipient_id, row.ip_address, row.user_agent]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => time(a) - time(b));
    let end = 0;
    const urls = new Map();
    const ranges = [];
    for (let start = 0; start < group.length; start++) {
      while (end < group.length && time(group[end]) - time(group[start]) <= 1000) {
        const url = group[end++].original_url;
        if (url) urls.set(url, (urls.get(url) || 0) + 1);
      }
      if (urls.size >= 3) ranges.push([start, end]);
      const url = group[start].original_url;
      if (url && urls.get(url) === 1) urls.delete(url);
      else if (url) urls.set(url, urls.get(url) - 1);
    }
    let marked = 0;
    for (const [start, stop] of ranges) {
      for (let i = Math.max(start, marked); i < stop; i++)
        group[i].classification_reasons.push('rapid_multi_link_burst');
      marked = Math.max(marked, stop);
    }
  }
  const bots = new Map();
  for (const evidence of providerEvents) {
    const raw = evidence.raw_event;
    const client = raw?.['client-info'];
    if (raw?._iconnect_verified_provider !== true || raw.event !== 'clicked' ||
      !['apple', 'gmail', 'generic'].includes(client?.bot) || !raw.ip || !client?.['user-agent']) continue;
    let url = raw.url;
    try {
      const tracked = new URL(url);
      if (tracked.pathname === '/api/track/click') {
        const [campaign, recipient] = Buffer.from(tracked.searchParams.get('t') || '', 'base64url').toString().split(':');
        if (campaign !== evidence.campaign_id || recipient !== evidence.recipient_id) continue;
        url = tracked.searchParams.get('url');
      }
    } catch { /* Plain historical URLs still require an exact match. */ }
    const key = JSON.stringify([evidence.campaign_id, evidence.recipient_id, url, raw.ip, client['user-agent']]);
    if (!bots.has(key)) bots.set(key, []);
    bots.get(key).push(Number(raw.timestamp) * 1000);
  }
  for (const row of events) {
    const key = JSON.stringify([row.campaign_id, row.recipient_id, row.original_url, row.ip_address, row.user_agent]);
    // Narrow event-level correlation only; never taint every click by a recipient.
    if (bots.get(key)?.some(t => Number.isFinite(t) && Math.abs(time(row) - t) <= 1000))
      row.classification_reasons.push('verified_provider_bot');
    row.suspected_automated = row.classification_reasons.length > 0;
  }
  const qualifying = events.filter(row => !row.suspected_automated);
  return { events, estimatedClicks: qualifying.length,
    estimatedClickedRecipients: new Set(qualifying.map(row => row.recipient_id)).size,
    suspectedAutomatedClicks: events.length - qualifying.length,
    classificationVersion: ENGAGEMENT_VERSION };
}

export async function loadCampaignEngagement(db, campaignId, tenantId) {
  const { error } = await db.from('email_campaign').select('id')
    .eq('id', campaignId).eq('tenant_id', tenantId).single();
  if (error) throw error;
  async function all(table, columns, provider = false) {
    const rows = [];
    let expected;
    for (let offset = 0; ; offset += 500) {
      let query = db.from(table).select(columns, { count: 'exact' }).eq('campaign_id', campaignId);
      if (provider) query = query.eq('event_type', 'clicked').eq('tenant_id', tenantId);
      const result = await query.order('id', { ascending: true }).range(offset, offset + 499);
      if (result.error) throw result.error;
      if (!Number.isInteger(result.count) || (expected !== undefined && result.count !== expected))
        throw new Error('Engagement evidence changed while loading; retry');
      expected = result.count;
      rows.push(...(result.data || []));
      if (rows.length === expected) return rows;
      if (!result.data?.length || rows.length > expected || rows.length > 100000)
        throw new Error('Complete engagement evidence unavailable');
      // Advance by actual returned rows even with a lower provider page cap.
      offset += result.data.length - 500;
    }
  }
  const [requests, provider] = await Promise.all([
    all('email_counted_link_click', '*'),
    all('email_event', 'campaign_id,recipient_id,raw_event', true),
  ]);
  return classifyCampaignEngagement(requests, provider);
}
