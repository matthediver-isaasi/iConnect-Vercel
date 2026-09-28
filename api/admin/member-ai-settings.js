// Tenant operator controls for the Member AI assistant. The endpoint is only
// available to a verified tenant-user session bound to the active tenant; a
// member portal session can never toggle its own limits.

import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { MEMBER_AI_DEFAULTS } from '../_lib/memberAiUsage.js';

const ALLOWED_CONTENT_TYPES = new Set(
  ['resource', 'event', 'complex_event', 'news_post', 'blog_post', 'canvas_page']
);

function validLimit(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const ctx = await getTenantContext(req);
  const tenantUser = await getSessionTenantUser(req);
  const userTenantId = tenantUser?._sessionTenantId || tenantUser?.tenant_id;
  if (!ctx?.isAuthenticated || !ctx.tenantId || !tenantUser || userTenantId !== ctx.tenantId) {
    return res.status(403).json({ error: 'Tenant administrator access required.' });
  }
  if (!['owner', 'admin', 'super_admin'].includes(tenantUser.role)) {
    return res.status(403).json({ error: 'Tenant administrator access required.' });
  }
  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('member_ai_settings')
        .select('enabled, public_enabled, per_member_hourly_limit, per_ip_hourly_limit, tenant_monthly_limit, max_concurrent_requests, allowed_content_types, updated_at')
        .eq('tenant_id', ctx.tenantId)
        .maybeSingle();
      if (error) throw error;
      return res.status(200).json({ settings: data || MEMBER_AI_DEFAULTS });
    }
    if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });
    const enabled = req.body?.enabled;
    const publicEnabled = req.body?.public_enabled;
    const hourly = req.body?.per_member_hourly_limit;
    const ipHourly = req.body?.per_ip_hourly_limit;
    const monthly = req.body?.tenant_monthly_limit;
    const concurrent = req.body?.max_concurrent_requests;
    const allowedContentTypes = req.body?.allowed_content_types;
    if (
      typeof enabled !== 'boolean' ||
      typeof publicEnabled !== 'boolean' ||
      !validLimit(hourly, 1, 500) ||
      !validLimit(ipHourly, 1, 500) ||
      !validLimit(monthly, 1, 100000) ||
      !validLimit(concurrent, 1, 100) ||
      !Array.isArray(allowedContentTypes) ||
      !allowedContentTypes.length ||
      allowedContentTypes.some((type) => !ALLOWED_CONTENT_TYPES.has(type))
    ) {
      return res.status(400).json({
          error: 'Valid limits and a non-empty allowed_content_types subset are required.',
      });
    }
    const row = {
      tenant_id: ctx.tenantId,
      enabled,
      public_enabled: publicEnabled,
      per_member_hourly_limit: hourly,
      per_ip_hourly_limit: ipHourly,
      tenant_monthly_limit: monthly,
      max_concurrent_requests: concurrent,
      allowed_content_types: [...new Set(allowedContentTypes)],
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from('member_ai_settings')
      .upsert(row, { onConflict: 'tenant_id' })
        .select('enabled, public_enabled, per_member_hourly_limit, per_ip_hourly_limit, tenant_monthly_limit, max_concurrent_requests, allowed_content_types, updated_at')
      .single();
    if (error) throw error;
    return res.status(200).json({ settings: data });
  } catch (error) {
    console.error('[Member AI settings] Error:', error);
    return res.status(500).json({ error: 'Unable to update Member AI settings.' });
  }
}