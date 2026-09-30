import { createClient } from '@supabase/supabase-js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  canAccessRelationshipLabelContext,
  loadSubmissionScopedRelationshipDisplayLabels,
  resolveReviewSubmissionIds,
} from '../_lib/relationshipDisplayLabelAccess.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId || tenantCtx.tenantMismatch) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const recordIds = req.body?.recordIds;
  const submissionIds = req.body?.submissionIds;
  const context = req.body?.context;
  if (!Array.isArray(recordIds)) return res.status(400).json({ error: 'recordIds must be an array' });
  if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
    return res.status(400).json({ error: 'submissionIds must be a non-empty array' });
  }
  if (!['form-submissions', 'review-submission'].includes(context)) {
    return res.status(400).json({ error: 'A valid submission context is required' });
  }
  if (recordIds.length > 2000) return res.status(400).json({ error: 'Too many record IDs' });
  if (submissionIds.length > 2000) return res.status(400).json({ error: 'Too many submission IDs' });

  try {
    // Match the page-level authorization used by the callers. A tenant
    // membership alone must not be enough to enumerate custom-object labels.
    // Tenant dashboard users are authorized administrators. Portal member
    // sessions still require a tenant-scoped role and the context capability.
    if (!tenantCtx.tenantUserId) {
      if (!tenantCtx.roleId) return res.status(403).json({ error: 'Access denied' });
      const { data: role, error: roleError } = await supabase
        .from('role')
        .select('excluded_features')
        .eq('id', tenantCtx.roleId)
        .eq('tenant_id', tenantCtx.tenantId)
        .single();
      const excludedFeatures = [
        ...(Array.isArray(role?.excluded_features) ? role.excluded_features : []),
        ...(Array.isArray(tenantCtx.memberExcludedFeatures) ? tenantCtx.memberExcludedFeatures : []),
      ];
      if (roleError || !role || !canAccessRelationshipLabelContext(excludedFeatures, context)) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const authorizedSubmissionIds = context === 'review-submission'
      ? await resolveReviewSubmissionIds(supabase, tenantCtx.tenantId, submissionIds)
      : submissionIds;
    const labels = await loadSubmissionScopedRelationshipDisplayLabels(
      supabase,
      tenantCtx.tenantId,
      authorizedSubmissionIds,
      recordIds,
    );
    return res.status(200).json({ labels });
  } catch (error) {
    console.error('[Relationship display labels] Error:', error);
    return res.status(500).json({ error: 'Failed to resolve relationship labels' });
  }
}