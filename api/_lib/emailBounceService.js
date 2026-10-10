const normalize = value => String(value || '').trim().toLowerCase();
// PostgREST rewrites literal '*' in LIKE patterns; regex literals do not.
const literal = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export async function campaignAddressSuppressed(db, tenantId, email) {
  const { data, error } = await db.from('email_address_bounce').select('id')
    .eq('tenant_id', tenantId).eq('email', normalize(email)).is('resolved_at', null).maybeSingle();
  if (error) throw new Error('Campaign bounce suppression could not be checked');
  return Boolean(data);
}
export async function loadBounces(db, tenantId, query) {
  if (query.memberId) {
    const { data: member, error } = await db.from('member').select('email')
      .eq('tenant_id', tenantId).eq('id', query.memberId).maybeSingle();
    if (error) throw error;
    if (!member) throw Object.assign(new Error('Member not found'), { status: 404 });
    const { data, error: bounceError } = await db.from('email_address_bounce').select('*')
      .eq('tenant_id', tenantId).eq('email', normalize(member.email)).is('resolved_at', null).maybeSingle();
    if (bounceError) throw bounceError;
    return { item: data };
  }
  const page = Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1));
  let q = db.from('email_address_bounce').select('*', { count: 'exact' }).eq('tenant_id', tenantId);
  if (query.view === 'resolved') q = q.not('resolved_at', 'is', null);
  else if (query.view !== 'all') q = q.is('resolved_at', null);
  if (query.search) q = q.filter('email', 'imatch', literal(String(query.search).slice(0, 200)));
  const { data, count, error } = await q.order('last_bounced_at', { ascending: false }).order('id').range((page - 1) * 50, page * 50 - 1);
  if (error) throw error;
  const items = await Promise.all((data || []).map(async row => {
    const [members, campaign] = await Promise.all([
      db.from('member').select('id,first_name,last_name').eq('tenant_id', tenantId).filter('email', 'imatch', `^${literal(row.email)}$`).limit(50),
      row.campaign_id ? db.from('email_campaign').select('name').eq('tenant_id', tenantId).eq('id', row.campaign_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    if (members.error || campaign.error) throw members.error || campaign.error;
    return { ...row, campaign_name: campaign.data?.name || null,
      members: (members.data || []).map(m => ({ id: m.id, name: [m.first_name, m.last_name].filter(Boolean).join(' ') })) };
  }));
  return { items, total: count, page, pageSize: 50 };
}

// GET only: do not remove a provider suppression, send a test, or change consent.
export async function checkProviderBounce(db, tenantId, email, fetcher = fetch) {
  const { data: tenant, error } = await db.from('tenant').select('settings').eq('id', tenantId).single();
  if (error) throw error;
  const config = tenant.settings?.email_domain;
  const domain = config?.status === 'verified' ? config.domain : process.env.MAILGUN_DOMAIN;
  if (!domain || !process.env.MAILGUN_API_KEY) throw new Error('Provider suppression check is unavailable');
  const base = process.env.MAILGUN_REGION === 'us' ? 'https://api.mailgun.net' : 'https://api.eu.mailgun.net';
  const headers = { Authorization: `Basic ${Buffer.from(`api:${process.env.MAILGUN_API_KEY}`).toString('base64')}` };
  // A 404 for an inaccessible/misconfigured domain is not proof that an
  // address is absent from its suppression list.
  const domainCheck = await fetcher(`${base}/v3/domains/${encodeURIComponent(domain)}`, {
    headers, signal: AbortSignal.timeout(15000),
  });
  if (!domainCheck.ok) throw new Error('Sending domain could not be verified; campaigns remain paused');
  const response = await fetcher(`${base}/v3/${encodeURIComponent(domain)}/bounces/${encodeURIComponent(email)}`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (response.ok) throw Object.assign(new Error('Mailgun still suppresses this address. Resolve the provider bounce suppression before resuming campaigns.'), { status: 409 });
  if (response.status !== 404) throw new Error('Provider suppression check failed; campaigns remain paused');
  return { domain, checkedAt: new Date().toISOString() };
}
export async function resolveBounce(db, context, body, check = checkProviderBounce) {
  const reason = String(body.reason || '').trim();
  if (reason.length < 5 || reason.length > 1000 || !body.id || !body.expectedLastBouncedAt) {
    throw Object.assign(new Error('Supply a reason of 5–1000 characters and the current bounce timestamp'), { status: 400 });
  }
  const { data: row, error } = await db.from('email_address_bounce').select('*').eq('tenant_id', context.tenantId).eq('id', body.id).maybeSingle();
  if (error) throw error;
  if (!row) throw Object.assign(new Error('Bounce not found'), { status: 404 });
  if (row.resolved_at || new Date(row.last_bounced_at).getTime() !== new Date(body.expectedLastBouncedAt).getTime())
    throw Object.assign(new Error('Bounce changed; refresh before continuing'), { status: 409 });
  const provider = await check(db, context.tenantId, row.email);
  const { data, error: resolveError } = await db.rpc('resolve_email_address_bounce', {
    p_tenant: context.tenantId, p_id: row.id, p_last: row.last_bounced_at,
    p_actor: context.tenantUserId || context.memberId || context.userId,
    p_reason: reason, p_domain: provider.domain, p_checked: provider.checkedAt,
  });
  if (resolveError) throw resolveError;
  if (!data) throw Object.assign(new Error('Bounce changed; refresh before continuing'), { status: 409 });
  return { ok: true };
}
