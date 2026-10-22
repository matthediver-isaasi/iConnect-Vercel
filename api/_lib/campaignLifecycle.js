import { isMissingCampaignSummary, readLegacyCampaignSummary } from './campaignReads.js';

// Service-only SQL operations. Never fall back to child-first deletion or
// pretend a missing archive migration means a successful lifecycle change.
export function campaignLifecycleError(error) {
  const unavailable = ['42883', '42703', '42P01', 'PGRST202', 'PGRST204'].includes(error?.code);
  return {
    success: false,
    code: unavailable ? 'CAMPAIGN_LIFECYCLE_UNAVAILABLE' : error?.code,
    statusCode: unavailable || error?.code === '57014' ? 503 : error?.code === 'P0002' ? 404
      : ['55000', '23503', '40001', '40P01'].includes(error?.code) ? 409 : 500,
    error: unavailable
      ? 'Campaign archive management requires the approved database migration. No changes were made.'
      : error?.code === '57014'
        ? 'The campaign operation timed out. No changes were made. Wait a moment and retry. If it times out again, contact your administrator with error code 57014.'
      : error?.code === '23503'
        ? 'This campaign has protected linked history and cannot be deleted. Archive it instead. No changes were made.'
        : error?.message || 'Campaign operation failed.',
  };
}

export async function campaignLifecycle(db, campaignId, tenantId, action) {
  if (!db || !tenantId) return { success: false, statusCode: 503, error: 'Database not configured or missing tenant' };
  const { data, error } = await db.rpc('campaign_lifecycle', {
    p_campaign: campaignId, p_tenant: tenantId, p_action: action,
  });
  if (error) return campaignLifecycleError(error);
  if (!data) return { success: false, statusCode: 500, error: 'Campaign operation returned no confirmation.' };
  return { success: true, campaign: data };
}

export async function campaignLifecycleReady(db) {
  if (!db) return { success: false, statusCode: 503, error: 'Database not configured' };
  const { data, error } = await db.rpc('campaign_lifecycle_ready');
  if (error) return campaignLifecycleError(error);
  if (data !== true) return { success: false, statusCode: 503, error: 'Campaign archive management is not ready.' };
  return { success: true, ready: true };
}

export async function campaignSummary(db, tenantId) {
  if (!db || !tenantId) return { success: false, statusCode: 503, error: 'Database not configured or missing tenant' };
  const { data, error } = await db.rpc('campaign_summary', { p_tenant: tenantId });
  if (error) {
    if (!isMissingCampaignSummary(error)) return campaignLifecycleError(error);
    try {
      return { success: true, summary: await readLegacyCampaignSummary(db, tenantId) };
    } catch (readError) {
      return {
        success: false, statusCode: 500, code: readError?.code,
        error: readError?.message || 'Campaign summary read failed.',
      };
    }
  }
  if (!data) return { success: false, statusCode: 503, error: 'Campaign summary is unavailable.' };
  return { success: true, summary: data };
}

export function archivedCampaignConflict(campaign) {
  return campaign?.archived_at ? {
    success: false, statusCode: 409, code: 'CAMPAIGN_ARCHIVED',
    error: 'This campaign is archived. Restore it before editing, sending, scheduling or resuming.',
  } : null;
}

export async function guardArchivedCampaignWrite(db, campaignId, context) {
  if (!context?.isAuthenticated || !context?.tenantId) {
    return { success: false, statusCode: 401, error: 'Authentication required' };
  }
  if (context.tenantMismatch) return { success: false, statusCode: 403, error: 'Tenant context mismatch' };
  const { data, error } = await db.from('email_campaign').select('archived_at')
    .eq('id', campaignId).eq('tenant_id', context.tenantId).maybeSingle();
  if (error) return campaignLifecycleError(error);
  if (!data) return { success: false, statusCode: 404, error: 'Campaign not found' };
  // The SQL trigger repeats the check under the row lock; this preflight only
  // gives the legacy generic API an actionable response before its side effects.
  return archivedCampaignConflict(data);
}

// Test sends do not create recipient claims. Reserve the campaign before
// provider work so archive/delete cannot race this otherwise-untracked path.
export async function beginCampaignTestSend(db, campaignId, tenantId) {
  const { data, error } = await db.rpc('campaign_test_send_begin', {
    p_campaign: campaignId, p_tenant: tenantId,
  });
  if (error) return campaignLifecycleError(error);
  if (!data) return { success: false, statusCode: 503, error: 'Could not reserve campaign test delivery.' };
  return { success: true, lease: data };
}

export async function finishCampaignTestSend(db, campaignId, tenantId, lease, results) {
  // A returned failure may be a timeout after acceptance. Leave its reservation
  // intact for explicit reconciliation rather than guessing that no email went.
  if (!results.length || results.some(result => !result.success)) {
    return { reconciliationRequired: true };
  }
  const { data, error } = await db.rpc('campaign_test_send_end', {
    p_campaign: campaignId, p_tenant: tenantId, p_lease: lease,
  });
  return { reconciliationRequired: !!error || data !== true };
}
