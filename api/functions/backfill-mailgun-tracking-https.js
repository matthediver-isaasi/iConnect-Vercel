import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { reconcileMailgunTrackingHttps } from '../_lib/emailDomainService.js';

const BACKFILL_API_KEY = process.env.BACKFILL_API_KEY;
const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 50;
const RECONCILIATION_CONCURRENCY = 10;

export function reconcileSendingDomainStatus(existingStatus, mailgunDomainActive) {
  if (mailgunDomainActive === true) return 'verified';
  if (mailgunDomainActive === false) return 'pending';
  return existingStatus;
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function getTenants(tenantId, cursor, batchSize) {
  if (tenantId) {
    const { data, error } = await supabase.from('tenant').select('id, slug, settings').eq('id', tenantId);
    if (error) throw error;
    return { tenants: data || [], hasMore: false };
  }
  let query = supabase.from('tenant').select('id, slug, settings')
    .order('id', { ascending: true }).limit(batchSize + 1);
  if (cursor) query = query.gt('id', cursor);
  const { data, error } = await query;
  if (error) throw error;
  return { tenants: (data || []).slice(0, batchSize), hasMore: (data || []).length > batchSize };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Backfill-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const all = req.body?.all === true;
  const cursor = typeof req.body?.cursor === 'string' ? req.body.cursor : null;
  const requestedBatchSize = Number(req.body?.batch_size);
  const batchSize = Number.isFinite(requestedBatchSize)
    ? Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(requestedBatchSize)))
    : DEFAULT_BATCH_SIZE;
  let tenantId = null;
  if (all) {
    if (!BACKFILL_API_KEY || req.headers['x-backfill-key'] !== BACKFILL_API_KEY) {
      return res.status(403).json({ error: 'Forbidden - auditing all tenants requires a valid X-Backfill-Key header' });
    }
  } else {
    const context = await getTenantContext(req);
    if (!context.tenantId) return res.status(401).json({ error: 'Unauthorized - tenant required' });
    const tenantUser = await getSessionTenantUser(req);
    const isAuthorized = tenantUser && ['owner', 'admin', 'super_admin'].includes(tenantUser.role);
    if (!isAuthorized) return res.status(403).json({ error: 'Forbidden - requires owner or admin role' });
    tenantId = context.tenantId;
  }

  try {
    const tenantPage = await getTenants(tenantId, cursor, batchSize);
    const tenants = tenantPage.tenants;

    const results = await mapWithConcurrency(tenants || [], RECONCILIATION_CONCURRENCY, async tenant => {
      const config = tenant.settings?.email_domain;
      if (!config?.domain) {
        return { tenant_id: tenant.id, slug: tenant.slug, status: 'skipped', reason: 'No email domain configured' };
      }
      const outcome = await reconcileMailgunTrackingHttps(config.domain);
      const updatedConfig = {
        ...config,
        status: reconcileSendingDomainStatus(config.status, outcome.mailgun_domain_active),
        tracking_scheme: outcome.tracking_scheme,
        mailgun_domain_active: outcome.mailgun_domain_active,
        tracking_hostname: outcome.tracking_hostname,
        tracking_dns_valid: outcome.tracking_dns_valid,
        tracking_certificate_ready: outcome.tracking_certificate_ready,
        tracking_tls_ready: outcome.tracking_tls_ready,
        tracking_tls_status: outcome.tracking_tls_status,
        tracking_tls_action: outcome.tracking_tls_action,
        tracking_tls_error: outcome.tracking_tls_error,
        tracking_tls_error_code: outcome.tracking_tls_error_code,
        tracking_tls_dns_records: outcome.tracking_tls_dns_records,
        last_verified_at: new Date().toISOString(),
      };
      const { error: updateError } = await supabase.from('tenant')
        .update({ settings: { ...tenant.settings, email_domain: updatedConfig } }).eq('id', tenant.id);
      return {
        tenant_id: tenant.id,
        slug: tenant.slug,
        domain: config.domain,
        from_email: config.from_email,
        is_custom: !!config.is_custom,
        status: updateError || !outcome.operation_succeeded
          ? 'failed'
          : (outcome.tracking_tls_ready ? 'success' : 'pending'),
        changed: outcome.changed,
        before_scheme: outcome.before_scheme,
        tracking_scheme: outcome.tracking_scheme,
        tracking_hostname: outcome.tracking_hostname,
        tracking_dns_valid: outcome.tracking_dns_valid,
        tracking_certificate_ready: outcome.tracking_certificate_ready,
        tracking_tls_ready: outcome.tracking_tls_ready,
        action_required: outcome.tracking_tls_action,
        error: updateError?.message || outcome.tracking_tls_error || null,
      };
    });
    return res.status(200).json({
      success: true,
      scope: all ? 'all_tenants' : 'single_tenant',
      has_more: tenantPage.hasMore,
      next_cursor: tenantPage.hasMore ? tenants[tenants.length - 1]?.id || null : null,
      summary: {
        total: results.length,
        success: results.filter(item => item.status === 'success').length,
        pending: results.filter(item => item.status === 'pending').length,
        skipped: results.filter(item => item.status === 'skipped').length,
        failed: results.filter(item => item.status === 'failed').length,
      },
      results,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to audit HTTPS tracking domains', details: error.message });
  }
}