import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { validateSurveyForPublish } from '../_lib/surveyScoring.js';

/**
 * Task #3330: server-authoritative survey publishing.
 *
 * Creates the immutable survey_version snapshot and flips the form's
 * survey_settings to published. SurveyVersion rows are server-write-only
 * (the generic entity API rejects writes), so this endpoint is the ONLY
 * way a version snapshot comes into existence.
 *
 * POST { form_id }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const tenantCtx = await getTenantContext(req);
    if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // Admin-only: getTenantIdFromSession-style membership checks are not
    // enough for publish (see tenant-session-admin-gate).
    const isAdmin = await hasAdminAccess(tenantCtx);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { form_id } = req.body || {};
    if (!form_id) {
      return res.status(400).json({ error: 'form_id is required' });
    }

    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, tenant_id, form_type, fields, pages, visibility_rules, survey_settings, survey_audit_log')
      .eq('id', form_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();
    if (formError || !form) {
      return res.status(404).json({ error: 'Form not found' });
    }
    if (form.form_type !== 'survey') {
      return res.status(400).json({ error: 'Only survey forms can be published' });
    }

    // Server-side validation gate — publishing is blocked until it passes.
    const validation = validateSurveyForPublish(form.fields || [], form.survey_settings || {});
    if (validation.errors.length > 0) {
      return res.status(400).json({
        error: 'Survey failed publish validation',
        details: validation.errors
      });
    }

    // Resolve the acting admin's email for the audit trail / published_by.
    let actor = null;
    try {
      if (tenantCtx.memberId) {
        const { data: m } = await supabase.from('member').select('email').eq('id', tenantCtx.memberId).maybeSingle();
        actor = m?.email || null;
      } else if (tenantCtx.tenantUserId) {
        const { data: tu } = await supabase.from('tenant_user').select('email').eq('id', tenantCtx.tenantUserId).maybeSingle();
        actor = tu?.email || null;
      }
    } catch { /* actor is best-effort */ }

    // Fully atomic publish (service-role-only RPC, advisory-locked):
    // unchanged-config idempotence check, version allocation, and the form
    // status/current_version/audit update all commit in one transaction —
    // concurrent publishes can never leave the pointer inconsistent or
    // drop audit entries.
    const { data: result, error: publishError } = await supabase
      .rpc('publish_survey', {
        p_tenant_id: tenantCtx.tenantId,
        p_form_id: form.id,
        p_fields: form.fields || [],
        p_pages: form.pages || [],
        p_visibility_rules: form.visibility_rules || [],
        p_survey_settings: { ...(form.survey_settings || {}), status: 'published' },
        p_published_by: actor
      });
    if (publishError || !result?.version_id) {
      console.error('[Publish Survey] Publish RPC failed:', publishError);
      return res.status(500).json({ error: 'Failed to publish survey' });
    }

    return res.status(200).json({
      success: true,
      version_id: result.version_id,
      version_number: result.version_number,
      unchanged: result.unchanged === true,
      survey_settings: result.survey_settings,
      survey_audit_log: result.survey_audit_log
    });
  } catch (err) {
    console.error('[Publish Survey] Error:', err);
    return res.status(500).json({ error: 'Failed to publish survey' });
  }
}
