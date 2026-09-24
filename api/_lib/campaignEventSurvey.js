import { assignmentWindowState } from './surveyAssignment.js';
import { isFormScheduleAvailable } from './formAvailability.js';
import { getTenantTrustedBaseUrl } from './publicBaseUrl.js';

const tokenPattern = () => /\{\{event_survey_url\}\}|\[\[event\.survey_url\]\]/gi;
export function usesEventSurvey(campaign) {
  return tokenPattern().test(`${campaign?.subject || ''}\n${campaign?.html_content || ''}\n${JSON.stringify(campaign?.design_json || null)}`);
}
export function replaceEventSurvey(text, url) {
  return String(text || '').replace(tokenPattern(), () => url);
}
function reject(message) {
  throw new Error(`Event survey: ${message}`);
}

export async function resolveEventEmailSurvey(db, config, event, eventType) {
  const url = await resolveCampaignEventSurvey(db, {
    subject: config.subject, html_content: config.body,
    event_survey_context: {
      event_id: event.id, event_type: eventType,
      assignment_id: config.event_survey_assignment_id || null,
    },
  }, event.tenant_id);
  return {
    subject: url ? replaceEventSurvey(config.subject, url) : config.subject,
    body: url ? replaceEventSurvey(config.body, url) : config.body,
  };
}

// Resolve only explicit campaign context, never recipient bookings. No writes,
// token minting, access-mode changes or request-Origin dependencies.
export async function resolveCampaignEventSurvey(db, campaign, tenantId) {
  if (!usesEventSurvey(campaign)) return null;
  const context = campaign.event_survey_context;
  if (!context?.event_id || !['event', 'complex_event'].includes(context.event_type)) {
    reject('select an event in the campaign survey settings.');
  }
  async function one(table, filters, fields = '*') {
    let query = db.from(table).select(fields).eq('tenant_id', tenantId);
    for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
    const { data, error } = await query.maybeSingle();
    if (error) reject('could not validate the selected survey. Please retry.');
    return data;
  }
  const event = await one(context.event_type, { id: context.event_id });
  if (!event || event.status === 'archived' || event.is_active === false) reject('the selected event is unavailable.');
  let query = db.from('event_survey_assignment').select('*')
    .eq('tenant_id', tenantId).eq('event_type', context.event_type)
    .eq(context.event_type === 'event' ? 'event_id' : 'complex_event_id', context.event_id);
  if (context.assignment_id) query = query.eq('id', context.assignment_id);
  else query = query.eq('status', 'active');
  const { data: assignments, error } = await query;
  if (error) reject('could not validate assignments. Please retry.');
  if (!assignments?.length) reject('no matching survey assignment is available.');
  if (assignments.length !== 1) reject('this event has multiple surveys. Select a survey in this campaign.');
  const assignment = assignments[0];
  if (assignmentWindowState(assignment) !== 'open' || !assignment.token) reject('the selected survey assignment is not open.');
  const form = await one('form', { id: assignment.form_id });
  if (!form || !form.is_active || form.form_type !== 'survey' ||
      !isFormScheduleAvailable(form) || form.survey_settings?.status !== 'published') {
    reject('the selected survey must be active and published.');
  }
  const version = Number(form.survey_settings.current_version);
  if (!Number.isInteger(version) || version < 1 ||
      !await one('survey_version', { form_id: form.id, version_number: version }, 'id')) {
    reject('the selected survey has no published version.');
  }
  const { data: tenant, error: tenantError } = await db.from('tenant')
    .select('slug, domain').eq('id', tenantId).maybeSingle();
  if (tenantError || !tenant?.slug) reject('the tenant public URL is unavailable.');
  return `${getTenantTrustedBaseUrl(null, tenant)}/survey/${encodeURIComponent(assignment.token)}`;
}