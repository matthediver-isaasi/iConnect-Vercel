import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import { getSessionMember } from '../../_lib/session.js';
import { assignmentWindowState, assignmentClosedMessage } from '../../_lib/surveyAssignment.js';

/**
 * Task #3331: serve a survey via its event-assignment token.
 *
 * GET /api/public/survey-assignment/:token
 *
 * The server resolves EVERYTHING from the assignment: tenant match, survey
 * form, the CURRENT published version snapshot, the event and the access
 * mode. Clients never supply an event id. Outside the open/close window the
 * endpoint returns the window state (with event context) but no form config,
 * so a closed survey can render a friendly message without being fillable.
 */
const PUBLIC_FORM_FIELDS = [
  'id', 'name', 'slug', 'description', 'fields', 'is_active',
  'layout_type', 'submit_button_text', 'success_message', 'redirect_url',
  'visibility_rules', 'pages', 'blank_layout', 'updated_at',
  'form_type', 'survey_settings'
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { token } = req.query;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Assignment token is required' });
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
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Token is unguessable; STILL pin the row to the requesting tenant so a
    // leaked token can never be served on another tenant's domain.
    const { data: assignment, error: assignErr } = await supabase
      .from('event_survey_assignment')
      .select('*')
      .eq('token', token)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (assignErr || !assignment) {
      return res.status(404).json({ error: 'Survey not found' });
    }

    const windowState = assignmentWindowState(assignment);

    // Resolve live event context (title may have changed since the snapshot;
    // prefer live, fall back to the snapshot so deleted events still label).
    let eventInfo = {
      type: assignment.event_type,
      id: assignment.event_type === 'complex_event' ? assignment.complex_event_id : assignment.event_id,
      title: assignment.event_title,
      start_date: assignment.event_start_date,
    };
    try {
      if (eventInfo.id) {
        const table = assignment.event_type === 'complex_event' ? 'complex_event' : 'event';
        const { data: ev } = await supabase
          .from(table)
          .select('id, title, start_date')
          .eq('id', eventInfo.id)
          .eq('tenant_id', tenant.id)
          .maybeSingle();
        if (ev) {
          eventInfo.title = ev.title || eventInfo.title;
          eventInfo.start_date = ev.start_date || eventInfo.start_date;
        }
      }
    } catch {
      // Live event lookup is best-effort; snapshot values remain.
    }

    const baseResponse = {
      assignment: {
        token: assignment.token,
        access_mode: assignment.access_mode,
        opens_at: assignment.opens_at,
        closes_at: assignment.closes_at,
        window_state: windowState,
      },
      event: eventInfo,
    };

    if (windowState !== 'open') {
      return res.status(200).json({
        ...baseResponse,
        closed_message: assignmentClosedMessage(windowState),
      });
    }

    // Authenticated-only assignments require a valid SAME-TENANT member
    // session before the form config is released.
    let hasTenantSession = false;
    try {
      const sessionMember = await getSessionMember(req);
      const memberTenantId = sessionMember?.tenant_id || sessionMember?.organization?.tenant_id || null;
      hasTenantSession = !!sessionMember && memberTenantId === tenant.id;
    } catch {
      hasTenantSession = false;
    }
    if (assignment.access_mode === 'authenticated' && !hasTenantSession) {
      return res.status(200).json({
        ...baseResponse,
        require_authentication: true,
      });
    }

    // Load the survey form — must still be an active, published survey.
    const { data: form, error: formErr } = await supabase
      .from('form')
      .select('*')
      .eq('id', assignment.form_id)
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .maybeSingle();
    if (formErr || !form || form.form_type !== 'survey') {
      return res.status(404).json({ error: 'Survey not found' });
    }
    if (form.survey_settings?.status !== 'published') {
      return res.status(200).json({
        ...baseResponse,
        closed_message: 'This survey is not accepting responses.',
      });
    }
    const currentVersion = Number(form.survey_settings?.current_version);
    if (!Number.isInteger(currentVersion) || currentVersion < 1) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    // Serve the IMMUTABLE current published snapshot — the same config the
    // submission endpoint validates/scores against.
    const { data: snapshot } = await supabase
      .from('survey_version')
      .select('fields, pages, visibility_rules, survey_settings, version_number')
      .eq('form_id', form.id)
      .eq('tenant_id', tenant.id)
      .eq('version_number', currentVersion)
      .maybeSingle();
    if (!snapshot) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    form.fields = snapshot.fields || [];
    form.pages = snapshot.pages || [];
    form.visibility_rules = snapshot.visibility_rules || [];
    form.survey_settings = {
      ...(snapshot.survey_settings || {}),
      status: 'published',
      current_version: currentVersion,
    };

    const publicForm = {};
    for (const field of PUBLIC_FORM_FIELDS) {
      if (form[field] !== undefined) publicForm[field] = form[field];
    }

    return res.status(200).json({
      ...baseResponse,
      form: publicForm,
    });
  } catch (err) {
    console.error('[Survey Assignment API] Error:', err);
    return res.status(500).json({ error: 'Failed to load survey' });
  }
}
