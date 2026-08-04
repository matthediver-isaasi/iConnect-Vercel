import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { generateAssignmentToken } from '../_lib/surveyAssignment.js';

/**
 * Task #3331: admin management of event survey assignments.
 *
 * EventSurveyAssignment rows are server-write-only (the generic entity API
 * rejects writes), so this endpoint is the ONLY way assignments are created,
 * updated, archived or deleted. It enforces:
 *  - admin-only access (getTenantContext + hasAdminAccess);
 *  - cross-tenant safety: the survey form AND the event must both belong to
 *    the caller's tenant (event id is resolved server-side, never trusted);
 *  - unguessable token generated server-side;
 *  - archive-not-delete: assignments with responses can never be deleted.
 *
 * POST   { form_id, event_type, event_id, opens_at?, closes_at?, access_mode? }
 * PATCH  { id, opens_at?, closes_at?, access_mode?, status? }
 * DELETE { id }
 */
export default async function handler(req, res) {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) {
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
    // Admin-only: membership alone is not enough (tenant-session-admin-gate).
    const isAdmin = await hasAdminAccess(tenantCtx);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const tenantId = tenantCtx.tenantId;

    // Resolve the acting admin's email for the audit trail.
    let actor = null;
    try {
      if (tenantCtx.memberId) {
        const { data: m } = await supabase.from('member').select('email').eq('id', tenantCtx.memberId).maybeSingle();
        actor = m?.email || null;
      } else if (tenantCtx.tenantUserId) {
        const { data: tu } = await supabase.from('tenant_user').select('email').eq('id', tenantCtx.tenantUserId).maybeSingle();
        actor = tu?.email || null;
      }
    } catch {
      // Audit attribution is best-effort; never blocks the operation.
    }

    if (req.method === 'POST') {
      return await createAssignment(req, res, tenantId, actor);
    }
    if (req.method === 'PATCH') {
      return await updateAssignment(req, res, tenantId, actor);
    }
    return await deleteAssignment(req, res, tenantId, actor);
  } catch (err) {
    console.error('[Event Survey Assignments] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function parseWindow(value, label) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return { ok: false, error: `${label} is not a valid date` };
  return { ok: true, value: new Date(t).toISOString() };
}

async function createAssignment(req, res, tenantId, actor) {
  const { form_id, event_type, event_id, opens_at, closes_at, access_mode } = req.body || {};
  if (!form_id || !event_id) {
    return res.status(400).json({ error: 'form_id and event_id are required' });
  }
  const type = event_type === 'complex_event' ? 'complex_event' : 'event';
  const mode = access_mode === 'authenticated' ? 'authenticated' : 'public';

  const opens = parseWindow(opens_at, 'opens_at');
  const closes = parseWindow(closes_at, 'closes_at');
  if (!opens.ok) return res.status(400).json({ error: opens.error });
  if (!closes.ok) return res.status(400).json({ error: closes.error });
  if (opens.value && closes.value && closes.value <= opens.value) {
    return res.status(400).json({ error: 'closes_at must be after opens_at' });
  }

  // Survey form must belong to THIS tenant and be a survey.
  const { data: form, error: formErr } = await supabase
    .from('form')
    .select('id, tenant_id, form_type, survey_settings')
    .eq('id', form_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (formErr || !form) {
    return res.status(404).json({ error: 'Form not found' });
  }
  if (form.form_type !== 'survey') {
    return res.status(400).json({ error: 'Only survey forms can be assigned to events' });
  }

  // Event must belong to THIS tenant (cross-tenant assignment impossible).
  // Snapshot title/date so historic results survive rename/archive/delete.
  let eventTitle = null;
  let eventStart = null;
  if (type === 'complex_event') {
    const { data: ev, error: evErr } = await supabase
      .from('complex_event')
      .select('id, title, start_date')
      .eq('id', event_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (evErr || !ev) return res.status(404).json({ error: 'Event not found' });
    eventTitle = ev.title || null;
    eventStart = ev.start_date || null;
  } else {
    const { data: ev, error: evErr } = await supabase
      .from('event')
      .select('id, title, start_date')
      .eq('id', event_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (evErr || !ev) return res.status(404).json({ error: 'Event not found' });
    eventTitle = ev.title || null;
    eventStart = ev.start_date || null;
  }

  // Prevent duplicate ACTIVE assignment of the same survey to the same event.
  const dupQuery = supabase
    .from('event_survey_assignment')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('form_id', form_id)
    .eq('status', 'active')
    .eq(type === 'complex_event' ? 'complex_event_id' : 'event_id', event_id)
    .limit(1);
  const { data: dup } = await dupQuery;
  if (dup && dup.length > 0) {
    return res.status(409).json({ error: 'This survey is already assigned to that event' });
  }

  // Reference snapshot of the current published version (the public flow
  // always serves the CURRENT published snapshot; responses stamp the
  // version actually served).
  let versionId = null;
  let versionNumber = null;
  const currentVersion = Number(form.survey_settings?.current_version);
  if (Number.isInteger(currentVersion) && currentVersion >= 1) {
    const { data: versionRow } = await supabase
      .from('survey_version')
      .select('id, version_number')
      .eq('form_id', form_id)
      .eq('tenant_id', tenantId)
      .eq('version_number', currentVersion)
      .maybeSingle();
    if (versionRow) {
      versionId = versionRow.id;
      versionNumber = versionRow.version_number;
    }
  }

  const { data: created, error: insertErr } = await supabase
    .from('event_survey_assignment')
    .insert({
      tenant_id: tenantId,
      form_id,
      survey_version_id: versionId,
      survey_version_number: versionNumber,
      event_type: type,
      event_id: type === 'event' ? event_id : null,
      complex_event_id: type === 'complex_event' ? event_id : null,
      event_title: eventTitle,
      event_start_date: eventStart,
      opens_at: opens.value,
      closes_at: closes.value,
      status: 'active',
      access_mode: mode,
      token: generateAssignmentToken(),
      created_by: actor,
    })
    .select()
    .single();
  if (insertErr) {
    console.error('[Event Survey Assignments] Insert failed:', insertErr);
    return res.status(500).json({ error: 'Failed to create assignment' });
  }
  console.log(`[Event Survey Assignments] AUDIT create assignment ${created.id} form=${form_id} ${type}=${event_id} by=${actor || 'unknown'}`);
  return res.status(200).json(created);
}

async function loadAssignment(res, tenantId, id) {
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return null;
  }
  const { data: row, error } = await supabase
    .from('event_survey_assignment')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error || !row) {
    res.status(404).json({ error: 'Assignment not found' });
    return null;
  }
  return row;
}

async function updateAssignment(req, res, tenantId, actor) {
  const { id, opens_at, closes_at, access_mode, status } = req.body || {};
  const row = await loadAssignment(res, tenantId, id);
  if (!row) return;

  const update = { updated_at: new Date().toISOString() };
  if (opens_at !== undefined) {
    const opens = parseWindow(opens_at, 'opens_at');
    if (!opens.ok) return res.status(400).json({ error: opens.error });
    update.opens_at = opens.value;
  }
  if (closes_at !== undefined) {
    const closes = parseWindow(closes_at, 'closes_at');
    if (!closes.ok) return res.status(400).json({ error: closes.error });
    update.closes_at = closes.value;
  }
  const finalOpens = update.opens_at !== undefined ? update.opens_at : row.opens_at;
  const finalCloses = update.closes_at !== undefined ? update.closes_at : row.closes_at;
  if (finalOpens && finalCloses && finalCloses <= finalOpens) {
    return res.status(400).json({ error: 'closes_at must be after opens_at' });
  }
  if (access_mode !== undefined) {
    if (!['public', 'authenticated'].includes(access_mode)) {
      return res.status(400).json({ error: 'Invalid access_mode' });
    }
    update.access_mode = access_mode;
  }
  if (status !== undefined) {
    if (!['active', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    update.status = status;
    if (status === 'archived' && row.status !== 'archived') {
      update.archived_by = actor;
      update.archived_at = new Date().toISOString();
    } else if (status === 'active') {
      update.archived_by = null;
      update.archived_at = null;
    }
  }

  const { data: updated, error: updateErr } = await supabase
    .from('event_survey_assignment')
    .update(update)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select()
    .single();
  if (updateErr) {
    console.error('[Event Survey Assignments] Update failed:', updateErr);
    return res.status(500).json({ error: 'Failed to update assignment' });
  }
  if (update.status) {
    console.log(`[Event Survey Assignments] AUDIT ${update.status === 'archived' ? 'archive' : 'reactivate'} assignment ${id} by=${actor || 'unknown'}`);
  }
  return res.status(200).json(updated);
}

async function deleteAssignment(req, res, tenantId, actor) {
  const id = (req.body || {}).id || req.query?.id;
  const row = await loadAssignment(res, tenantId, id);
  if (!row) return;

  // Archive-not-delete: check BOTH the denormalised counter and the actual
  // submission rows so a drifted counter can never allow deleting history.
  let hasResponses = (row.response_count || 0) > 0;
  if (!hasResponses) {
    const { data: subs, error: subErr } = await supabase
      .from('form_submission')
      .select('id')
      .eq('survey_assignment_id', id)
      .eq('tenant_id', tenantId)
      .limit(1);
    if (subErr) {
      console.error('[Event Survey Assignments] Response check failed:', subErr);
      return res.status(500).json({ error: 'Failed to verify responses' });
    }
    hasResponses = !!(subs && subs.length > 0);
  }
  if (hasResponses) {
    return res.status(409).json({
      error: 'This assignment has responses and cannot be deleted. Archive it instead.',
      code: 'HAS_RESPONSES',
    });
  }

  const { error: delErr } = await supabase
    .from('event_survey_assignment')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (delErr) {
    console.error('[Event Survey Assignments] Delete failed:', delErr);
    return res.status(500).json({ error: 'Failed to delete assignment' });
  }
  console.log(`[Event Survey Assignments] AUDIT delete assignment ${id} form=${row.form_id} by=${actor || 'unknown'}`);
  return res.status(200).json({ success: true });
}
