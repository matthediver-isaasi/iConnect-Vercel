import { isEnhancedAnonymousSettings } from '../../shared/surveyCompletionPolicy.js';

export const assignmentColumns = 'id, form_id, event_type, event_id, complex_event_id, event_title, status, created_date, survey_version_id';
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !/^deleted_.*@deleted\.local$/i.test(value);

export async function audienceRows(factory, label) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await factory().order('id', { ascending: true }).range(offset, offset + 999);
    if (error || !Array.isArray(data)) throw new Error(`${label} could not be loaded; survey audience targeting stopped`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function one(query, message) {
  const { data, error } = await query.maybeSingle();
  if (error || !data) throw new Error(message);
  return data;
}

export async function validateEventSurveyScope(db, tenantId, segment, knownForm) {
  const formId = segment.form_id || segment.ids?.[0];
  if (!formId || (segment.ids && (segment.ids.length !== 1 || segment.ids[0] !== formId))) {
    throw new Error('Select exactly one survey form');
  }
  if (typeof segment.received !== 'boolean') throw new Error('Select Responded or No response');
  const form = knownForm || await one(db.from('form').select('id, name, form_type, survey_settings')
    .eq('tenant_id', tenantId).eq('id', formId), 'Survey form not found');
  if (form.form_type !== 'survey') {
    if (segment.survey_assignment_id || segment.assignment_id) throw new Error('Survey assignment requires a survey form');
    return null;
  }
  const assignmentId = segment.survey_assignment_id || segment.assignment_id;
  if (!assignmentId) throw new Error('Select an exact survey assignment; legacy form-wide survey audiences require reselection');
  if (segment.assignment_id && segment.survey_assignment_id && segment.assignment_id !== segment.survey_assignment_id) {
    throw new Error('Conflicting survey assignment selections');
  }
  const assignment = await one(db.from('event_survey_assignment').select(assignmentColumns)
    .eq('tenant_id', tenantId).eq('form_id', formId).eq('id', assignmentId),
  'Select a survey assignment belonging to this form and tenant');
  const type = assignment.event_type;
  const eventId = type === 'complex_event' ? assignment.complex_event_id : assignment.event_id;
  if (!['event', 'complex_event'].includes(type) || !eventId
    || (type === 'event' ? assignment.complex_event_id : assignment.event_id)
    || (segment.event_id && segment.event_id !== eventId)
    || (segment.event_type && segment.event_type !== type)) throw new Error('Survey assignment event scope is invalid; reselect the event and survey');
  const event = await one(db.from(type).select('id, title').eq('tenant_id', tenantId).eq('id', eventId),
    'Survey assignment event is missing or inaccessible');
  return { form, assignment, event, eventId, eventType: type };
}

// Read policy metadata first. Never read anonymous answer data or infer its author.
export async function eventSurveyEvidence(db, tenantId, scope, { requireComplete = true } = {}) {
  const { form, assignment } = scope;
  const versions = await audienceRows(() => db.from('survey_version')
    .select('id, version_number, survey_settings').eq('tenant_id', tenantId).eq('form_id', form.id), 'Survey policy history');
  const byId = new Map(versions.map(v => [v.id, v]));
  const submissions = await audienceRows(() => db.from('form_submission')
    .select('id, survey_version_id, is_anonymous').eq('tenant_id', tenantId)
    .eq('form_id', form.id).eq('survey_assignment_id', assignment.id), 'Survey response policy evidence');
  const current = versions.find(v => v.version_number === Number(form.survey_settings?.current_version));
  const needsCurrentPolicy = assignment.status !== 'archived';
  if ((needsCurrentPolicy && !current) || !assignment.survey_version_id || !byId.has(assignment.survey_version_id)) {
    throw new Error('Survey historical response policy could not be verified');
  }
  const relevant = new Set([...(needsCurrentPolicy ? [current.id] : []), assignment.survey_version_id, ...submissions.map(s => s.survey_version_id)]);
  const identifiedVersions = [];
  let enhanced = false;
  for (const id of relevant) {
    const version = byId.get(id);
    if (!version) throw new Error('Survey historical response policy could not be verified');
    const settings = version.survey_settings;
    if (isEnhancedAnonymousSettings(settings)) enhanced = true;
    else if (settings?.response_identity === 'identified' && settings.anonymous_completion_version == null) identifiedVersions.push(id);
    else throw new Error('Unsupported survey: anonymous or unknown historical policy lacks trustworthy identifiable completion evidence');
  }
  for (const submission of submissions) {
    if (identifiedVersions.includes(submission.survey_version_id) && submission.is_anonymous === true) {
      throw new Error('Survey response identity policy is inconsistent');
    }
    if (!identifiedVersions.includes(submission.survey_version_id) && submission.is_anonymous !== true) {
      throw new Error('Survey anonymous response policy is inconsistent');
    }
  }
  const emails = new Set();
  if (enhanced) {
    const completions = await audienceRows(() => db.from('survey_completion')
      .select(requireComplete ? 'id' : 'id, recipient_email').eq('tenant_id', tenantId).eq('form_id', form.id)
      .eq('assignment_id', assignment.id), 'Survey completion evidence');
    // This ledger deliberately has no response/version linkage. A nonempty
    // ledger proves participation for its identities, NOT that every anonymous
    // response was identity-backed: public responses may have no email.
    // Even equal aggregate counts cannot establish completeness across repeated
    // answers (ledger deduplication), mixed historical versions, deleted answers,
    // or separate paginated reads. Do not manufacture an attribution relationship
    // to resolve that uncertainty. Until a trustworthy aggregate completeness
    // guarantee exists, populated anonymous histories cannot support No response.
    // Responded needs only positive evidence, so ledger identities remain usable.
    const anonymousResponses = submissions.filter(row => !identifiedVersions.includes(row.survey_version_id));
    if (requireComplete && (anonymousResponses.length || completions.length)) {
      throw new Error('No response is unsupported: anonymous completion evidence is missing a trustworthy completeness guarantee for historical responses; audience targeting stopped');
    }
    if (!requireComplete) {
      for (const row of completions) {
        const email = normalizeEmail(row.recipient_email);
        if (!validEmail(email)) throw new Error('Survey completion identity is unavailable');
        emails.add(email);
      }
    }
  }
  for (const versionId of identifiedVersions) {
    const identified = await audienceRows(() => db.from('form_submission')
      .select('id, submitted_by_email').eq('tenant_id', tenantId).eq('form_id', form.id)
      .eq('survey_assignment_id', assignment.id).eq('survey_version_id', versionId), 'Identified survey evidence');
    for (const row of identified) {
      const email = normalizeEmail(row.submitted_by_email);
      if (!validEmail(email)) throw new Error('Unsupported survey: an identified response lacks trustworthy recipient identity');
      emails.add(email);
    }
  }
  return emails;
}

export async function resolveEventSurveyAudience(db, tenantId, segment, knownForm) {
  const scope = await validateEventSurveyScope(db, tenantId, segment, knownForm);
  if (!scope) return null;
  const emails = await eventSurveyEvidence(db, tenantId, scope, { requireComplete: segment.received === false });
  const bookings = await audienceRows(() => db.from(scope.eventType === 'complex_event' ? 'complex_event_booking' : 'booking')
    .select('id, attendee_email, attendee_first_name, attendee_last_name')
    .eq('tenant_id', tenantId).eq('event_id', scope.eventId).eq('status', 'confirmed'), 'Confirmed survey attendees');
  const attendees = new Map();
  for (const booking of bookings) {
    const email = normalizeEmail(booking.attendee_email);
    // member_id on a booking is the purchaser, not the attendee.
    if (!validEmail(email) || emails.has(email) !== segment.received || attendees.has(email)) continue;
    attendees.set(email, { id: null, member_id: null, email,
      first_name: booking.attendee_first_name || '', last_name: booking.attendee_last_name || '' });
  }
  return [...attendees.values()];
}

export async function validateSurveyAudienceSegments(db, tenantId, segments) {
  for (const segment of segments) {
    if (segment?.type !== 'event_form') continue;
    const scope = await validateEventSurveyScope(db, tenantId, segment);
    if (scope) await eventSurveyEvidence(db, tenantId, scope, { requireComplete: segment.received === false });
  }
}