import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { registerMailgunWebhooks } from '../_lib/emailDomainService.js';

const ALLOWED_ORIGINS = ['https://iconn.app', 'https://www.iconn.app'];
const BACKFILL_API_KEY = process.env.BACKFILL_API_KEY;

function getAllowedOrigin(requestOrigin) {
  if (!requestOrigin) return ALLOWED_ORIGINS[0];
  if (ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  if (requestOrigin.endsWith('.iconn.app')) return requestOrigin;
  return ALLOWED_ORIGINS[0];
}

export default async function handler(req, res) {
  const origin = getAllowedOrigin(req.headers.origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Backfill-Key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const backfillKey = req.headers['x-backfill-key'];
  const { all } = req.body || {};
  let scope = 'single_tenant';
  let tenantId = null;

  if (all === true) {
    if (!BACKFILL_API_KEY || backfillKey !== BACKFILL_API_KEY) {
      return res.status(403).json({ error: 'Forbidden - backfilling all tenants requires a valid X-Backfill-Key header' });
    }
    scope = 'all_tenants';
    console.log('[Backfill Webhooks] All-tenant backfill authorized via API key');
  } else {
    const tenantUser = await getSessionTenantUser(req);
    if (!tenantUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const isAuthorized = tenantUser.role === 'owner' || tenantUser.role === 'admin' || !tenantUser.role;
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Forbidden - requires owner or admin role' });
    }

    tenantId = tenantUser.tenant_id;
    console.log('[Backfill Webhooks] Single-tenant backfill started by user:', tenantUser.email, 'for tenant:', tenantId);
  }

  try {
    let query = supabase.from('tenant').select('id, slug, name, settings');
    if (scope === 'single_tenant') {
      query = query.eq('id', tenantId);
    }

    const { data: tenants, error: tenantsError } = await query;
    if (tenantsError) throw tenantsError;

    const results = [];

    for (const tenant of tenants || []) {
      const emailDomain = tenant.settings?.email_domain?.domain;
      if (!emailDomain) {
        results.push({
          tenant_id: tenant.id,
          slug: tenant.slug,
          status: 'skipped',
          reason: 'No email domain configured'
        });
        continue;
      }

      try {
        const webhookResult = await registerMailgunWebhooks(emailDomain);
        results.push({
          tenant_id: tenant.id,
          slug: tenant.slug,
          domain: emailDomain,
          is_custom: tenant.settings?.email_domain?.is_custom || false,
          status: webhookResult.success ? 'success' : 'failed',
          summary: webhookResult.summary,
          details: webhookResult.results
        });
      } catch (err) {
        results.push({
          tenant_id: tenant.id,
          slug: tenant.slug,
          domain: emailDomain,
          status: 'error',
          error: err.message
        });
      }
    }

    const successCount = results.filter(r => r.status === 'success').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;
    const failedCount = results.filter(r => r.status === 'failed' || r.status === 'error').length;

    console.log(`[Backfill Webhooks] Complete (${scope}): ${successCount} success, ${skippedCount} skipped, ${failedCount} failed`);

    return res.status(200).json({
      success: true,
      scope,
      summary: {
        total: tenants?.length || 0,
        success: successCount,
        skipped: skippedCount,
        failed: failedCount
      },
      results
    });

  } catch (error) {
    console.error('[Backfill Webhooks] Error:', error);
    return res.status(500).json({
      error: 'Failed to backfill webhooks',
      details: error.message
    });
  }
}
