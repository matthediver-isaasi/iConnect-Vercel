import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const ctx = await getTenantContext(req);
  if (!ctx?.isAuthenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  let hasAccess = false;
  if (ctx.tenantUserId) {
    hasAccess = true;
  } else if (ctx.roleId) {
    hasAccess = await hasFeatureAccess(ctx.roleId, 'commerce.event-cancellations');
  }

  if (!hasAccess) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { email } = req.query;
  if (!email || email.length < 3) {
    return res.json({ exists: false });
  }

  try {
    const { data: member } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .ilike('email', email.trim())
      .not('email', 'ilike', 'deleted_%@deleted.local')
      .maybeSingle();

    return res.json({ exists: !!member });
  } catch (err) {
    console.error('[TransferCheckEmail] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
