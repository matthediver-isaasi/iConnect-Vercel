import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import { getSession } from '../../_lib/session.js';
import { rulesUseLmicOperators } from '../../_lib/formLmicConditions.js';
import { loadTenantLmicCodes } from '../../_lib/tenantLmicCodes.js';
import { resolveFormAccess, sendFormAccessDenied } from '../../_lib/formAccessPolicy.js';
import { isFormScheduleAvailable } from '../../_lib/formAvailability.js';

const PUBLIC_FORM_FIELDS = [
  'id', 'name', 'slug', 'description', 'fields', 'is_active', 
  'layout_type', 'submit_button_text', 'success_message', 'redirect_url',
  'send_email', 'email_templates', 'prefill_source', 'prefill_source_field_id',
  'visibility_rules', 'pages',
  'deactivate_at', 'deactivate_timezone',
  'entity_pipelines',
  'uniqueness_checks', 'application_level',
  'blank_layout',
  'require_authentication', 'updated_at',
  'allow_submitter_email_copy',
  'allow_save_continue_later',
  // Survey forms (Task #3330): the public renderer needs the type flag and
  // the presentation subset of survey settings (intro text, progress, etc.).
  'form_type', 'survey_settings'
];

const AUTHENTICATED_EXTRA_FIELDS = [
  'field_mappings', 'create_entity_type', 'default_member_role_id',
  'member_entity_action', 'organization_entity_action',
  'additional_member_creations'
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { slug } = req.query;

  if (!slug) {
    return res.status(400).json({ error: 'Form slug is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      console.error('[Public Form API] Tenant not found');
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: form, error } = await supabase
      .from('form')
      .select('*')
      .eq('slug', slug)
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Form not found or inactive' });
      }
      console.error('Error fetching form:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!form) {
      return res.status(404).json({ error: 'Form not found' });
    }

    // Scheduled deactivation: once the configured time has passed, treat the
    // form as inactive even though is_active is still true.
    if (!isFormScheduleAvailable(form)) {
      return res.status(404).json({ error: 'Form not found or inactive' });
    }

    const access = await resolveFormAccess({
      supabase, req, tenantId: tenant.id, policy: form.access_policy,
    });
    if (!access.allowed) return sendFormAccessDenied(res, access);

    const isAuthenticatedRequest = req.query.authenticated === '1';
    let hasValidSession = false;
    if (isAuthenticatedRequest) {
      try {
        const session = await getSession(req);
        hasValidSession = !!session;
      } catch (e) {
        console.error('[Public Form API] Session check error:', e);
      }
    }

    // Survey forms (Task #3330): only PUBLISHED surveys are publicly
    // reachable. Authenticated viewers (admin builder preview) may still see
    // drafts; archived surveys are gone for everyone.
    if (form.form_type === 'survey') {
      const surveyStatus = form.survey_settings?.status || 'draft';
      if (surveyStatus === 'archived' || (surveyStatus !== 'published' && !hasValidSession)) {
        return res.status(404).json({ error: 'Form not found or inactive' });
      }
      // Direct-access policy (Task #3331): once a survey has ACTIVE event
      // assignments, respondents must use an assignment link (/survey/:token)
      // so the event is server-resolved and dedupe scopes can't be mixed.
      // Authenticated viewers (builder preview) still see the form.
      if (surveyStatus === 'published' && !hasValidSession) {
        const { data: activeAssignments } = await supabase
          .from('event_survey_assignment')
          .select('id')
          .eq('form_id', form.id)
          .eq('tenant_id', form.tenant_id)
          .eq('status', 'active')
          .limit(1);
        if (activeAssignments && activeAssignments.length > 0) {
          return res.status(404).json({ error: 'Form not found or inactive' });
        }
      }
      // Published surveys serve the IMMUTABLE active snapshot, never the
      // mutable live row — respondents must see exactly what server-side
      // scoring validates against. Fail closed if the pointed snapshot is
      // missing. Drafts remain reachable ONLY with a valid session
      // (authenticated builder preview) and are served live.
      if (surveyStatus === 'published') {
        const currentVersion = Number(form.survey_settings?.current_version);
        if (!Number.isInteger(currentVersion) || currentVersion < 1) {
          return res.status(404).json({ error: 'Form not found or inactive' });
        }
        const { data: snapshot } = await supabase
          .from('survey_version')
          .select('fields, pages, visibility_rules, survey_settings, version_number')
          .eq('form_id', form.id)
          .eq('tenant_id', form.tenant_id)
          .eq('version_number', currentVersion)
          .maybeSingle();
        if (!snapshot) {
          return res.status(404).json({ error: 'Form not found or inactive' });
        }
        form.fields = snapshot.fields || [];
        form.pages = snapshot.pages || [];
        form.visibility_rules = snapshot.visibility_rules || [];
        form.survey_settings = {
          ...(snapshot.survey_settings || {}),
          status: 'published',
          current_version: currentVersion
        };
      }
    }

    if (form.require_authentication && !hasValidSession) {
      // Preview shape for auth-gated forms viewed without a valid session.
      // Keep it minimal (no authenticated-only mappings / entity config), but
      // preserve everything the multi-page navigation + per-page validation
      // depends on so an embedded form never renders with collapsed pages:
      //   - per-field page_id / column_index (page assignment + layout)
      //   - required + type-specific "is filled" inputs (contact / grouped)
      //   - textarea limit config (max_characters / limit_type)
      // plus the top-level `pages` array itself.
      const previewFields = (form.fields || []).map(f => ({
        id: f.id,
        label: f.label,
        type: f.type,
        required: f.required,
        page_id: f.page_id ?? null,
        column_index: f.column_index ?? null,
        max_characters: f.max_characters ?? null,
        limit_type: f.limit_type ?? null,
        contact_sub_fields: f.contact_sub_fields ?? null,
        sub_questions: f.sub_questions ?? null,
        min_completed: f.min_completed ?? null,
        max_completed: f.max_completed ?? null
      }));
      return res.json({
        name: form.name,
        slug: form.slug,
        description: form.description,
        fields: previewFields,
        pages: form.pages || [],
        is_active: form.is_active,
        layout_type: form.layout_type,
        submit_button_text: form.submit_button_text,
        require_authentication: true,
        access_policy_required: access.restricted,
        access
      });
    }

    const publicForm = {};
    for (const field of PUBLIC_FORM_FIELDS) {
      if (form[field] !== undefined) {
        publicForm[field] = form[field];
      }
    }
    publicForm.access_policy_required = access.restricted;
    publicForm.access = access;

    if (hasValidSession) {
      for (const field of AUTHENTICATED_EXTRA_FIELDS) {
        if (form[field] !== undefined) {
          publicForm[field] = form[field];
        }
      }
    }

    // Task #3477: LMIC conditional operators. When any rule uses
    // is_lmic / is_not_lmic, deliver the tenant's saved LMIC code list so
    // the public renderer can evaluate the rules live. Loaded fresh on every
    // form load, so admin edits to the LMIC list apply on next load.
    if (rulesUseLmicOperators(publicForm.visibility_rules)) {
      publicForm.lmic_country_codes = await loadTenantLmicCodes(supabase, tenant.id);
    }

    return res.json(publicForm);
  } catch (error) {
    console.error('Form fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch form' });
  }
}
