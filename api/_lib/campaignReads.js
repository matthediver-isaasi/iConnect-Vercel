// Read compatibility only: never use these checks to authorize a mutation.
export function isMissingCampaignArchiveColumn(error) {
  const message = error?.message || '';
  return (error?.code === '42703' &&
    /column\s+(?:public\.)?email_campaign\.archived_at\s+does not exist/i.test(message)) ||
    (error?.code === 'PGRST204' &&
      /Could not find the ['"]archived_at['"] column of ['"]email_campaign['"] in the schema cache/i.test(message));
}

export function isMissingCampaignSummary(error) {
  const message = error?.message || '';
  return (error?.code === 'PGRST202' &&
    /Could not find the function public\.campaign_summary(?:\(|\s)/i.test(message)) ||
    (error?.code === '42883' &&
      /function (?:public\.)?campaign_summary\([^)]*\) does not exist/i.test(message));
}

export async function readCampaignList(db, tenantId, options = {}) {
  const archive = options.archive || 'active';
  const read = async (legacy = false) => {
    const rows = [];
    while (!options.limit || rows.length < options.limit) {
      let query = db.from('email_campaign').select('*').eq('tenant_id', tenantId)
        .order('created_at', { ascending: false }).order('id', { ascending: false });
      if (!legacy && archive === 'active') query = query.is('archived_at', null);
      if (!legacy && archive === 'archived') query = query.not('archived_at', 'is', null);
      if (options.status) query = query.eq('status', options.status);
      const size = options.limit ? Math.min(500, options.limit - rows.length) : 500;
      const { data, error } = await query.range(rows.length, rows.length + size - 1);
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Campaign list returned no rows payload.');
      if (!data.length) break;
      rows.push(...data);
      // Continue even after a short page: PostgREST may cap below our page size.
    }
    return rows;
  };
  try {
    return await read();
  } catch (error) {
    if (archive !== 'archived' && isMissingCampaignArchiveColumn(error)) return read(true);
    throw error;
  }
}

async function scanSummaryRows(buildQuery, consume) {
  let cursor;
  while (true) {
    let query = buildQuery().order('id', { ascending: true }).limit(500);
    if (cursor) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Campaign summary returned no rows payload.');
    if (!data.length) return;
    const next = data[data.length - 1].id;
    if (!next || (cursor && next <= cursor)) throw new Error('Campaign summary pagination did not advance.');
    for (const row of data) consume(row);
    cursor = next;
    // Do not stop on short pages: the server's row cap is not necessarily 500.
  }
}

// Equivalent to campaign_summary in 202612310006_campaign_lifecycle.sql:
// all campaign statuses/archives count, but only sent campaigns' recipients
// contribute engagement. Parent joins enforce tenant scope without an IN URL.
export async function readLegacyCampaignSummary(db, tenantId) {
  const summary = {
    totalCampaigns: 0, sentCampaigns: 0, draftCount: 0, scheduledCount: 0,
    totalSent: 0, totalOpened: 0, totalClicked: 0, avgOpenRate: 0, avgClickRate: 0,
  };
  await scanSummaryRows(
    () => db.from('email_campaign').select('id,status').eq('tenant_id', tenantId),
    row => {
      summary.totalCampaigns++;
      if (row.status === 'sent') summary.sentCampaigns++;
      if (row.status === 'draft') summary.draftCount++;
      if (row.status === 'scheduled') summary.scheduledCount++;
    },
  );
  const recipientCount = async filter => {
    const query = db.from('email_campaign_recipient')
      .select('id,email_campaign!inner(tenant_id,status)', { count: 'exact', head: true })
      .eq('email_campaign.tenant_id', tenantId).eq('email_campaign.status', 'sent');
    const { count, error } = await filter(query);
    if (error) throw error;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Campaign summary returned no exact recipient count.');
    return count;
  };
  // Aggregate at the database: never download an entire recipient history.
  [summary.totalSent, summary.totalOpened, summary.totalClicked] = await Promise.all([
    recipientCount(query => query.in('status', ['sent', 'delivered', 'opened', 'clicked'])),
    recipientCount(query => query.gt('open_count', 0)),
    recipientCount(query => query.gt('click_count', 0)),
  ]);
  if (summary.totalSent) {
    summary.avgOpenRate = Math.round(1000 * summary.totalOpened / summary.totalSent) / 10;
    summary.avgClickRate = Math.round(1000 * summary.totalClicked / summary.totalSent) / 10;
  }
  return summary;
}
