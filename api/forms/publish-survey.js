import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { validateSurveyForPublish } from '../_lib/surveyScoring.js';
import {
  authorizeProtectedFormMutation,
  clearProtectedFormPasswordFailures,
  getRequestHeader,
  isProtectedDepartmentForm,
  isProtectedFormRateLimited,
  protectedFormAttemptKey,
  recordProtectedFormPasswordFailure,
} from '../_lib/protectedDepartmentForm.js';

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
export async function handlePublishSurvey(req, res, dependencies = {}) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const db = dependencies.supabase || supabase;
  if (!db) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const tenantCtx = await (dependencies.getTenantContext || getTenantContext)(req);
    if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (tenantCtx.tenantMismatch
      || (tenantCtx.effectiveTenantId && tenantCtx.effectiveTenantId !== tenantCtx.tenantId)) {
      return res.status(409).json({
        error: 'Your browser session has switched tenant.',
        code: 'TENANT_CONTEXT_CHANGED',
      });
    }
    // Admin-only: getTenantIdFromSession-style membership checks are not
    // enough for publish (see tenant-session-admin-gate).
    const isAdmin = await (dependencies.hasAdminAccess || hasAdminAccess)(tenantCtx);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { form_id } = req.body || {};
    if (!form_id) {
      return res.status(400).json({ error: 'form_id is required' });
    }
    const protectionAttemptKey = protectedFormAttemptKey(req);
    if (isProtectedDepartmentForm(form_id) && isProtectedFormRateLimited(protectionAttemptKey)) {
      return res.status(429).json({
        error: 'Too many password attempts. Please try again later.',
        code: 'PROTECTED_FORM_RATE_LIMITED',
      });
    }
    const protection = authorizeProtectedFormMutation({
      formId: form_id,
      tenantId: tenantCtx.effectiveTenantId || tenantCtx.tenantId,
      method: 'PATCH',
      body: { survey_settings: { status: 'published' } },
      password: getRequestHeader(req, 'x-form-protection-password'),
      env: dependencies.env || process.env,
    });
    if (!protection.ok) {
      if (protection.code === 'PROTECTED_FORM_PASSWORD_INCORRECT') {
        recordProtectedFormPasswordFailure(protectionAttemptKey);
      }
      return res.status(protection.status).json({ error: protection.error, code: protection.code });
    }
    if (protection.protected) clearProtectedFormPasswordFailures(protectionAttemptKey);

    const { data: form, error: formError } = await db
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
        const { data: m } = await db.from('member').select('email').eq('id', tenantCtx.memberId).maybeSingle();
        actor = m?.email || null;
      } else if (tenantCtx.tenantUserId) {
        const { data: tu } = await db.from('tenant_user').select('email').eq('id', tenantCtx.tenantUserId).maybeSingle();
        actor = tu?.email || null;
      }
    } catch { /* actor is best-effort */ }

    // Fully atomic publish (service-role-only RPC, advisory-locked):
    // unchanged-config idempotence check, version allocation, and the form
    // status/current_version/audit update all commit in one transaction —
    // concurrent publishes can never leave the pointer inconsistent or
    // drop audit entries.
    const { data: result, error: publishError } = await db
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

export default function handler(req, res) {
  return handlePublishSurvey(req, res);
}
