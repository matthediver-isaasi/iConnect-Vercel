import { validateEventSurveyScope } from './eventSurveyAudience.js';
import { isEnhancedAnonymousSettings } from '../../shared/surveyCompletionPolicy.js';
import { discoverAudienceCustomObjects, validateCustomObjectCondition, matchesCustomObjectValue } from './audienceCustomObjects.js';
import { customObjectSelectionKey } from '../../shared/audienceCustomObjectContract.js';
import { preparationError } from './campaignPreparation.js';
import { speakerAudienceChunk } from './eventSpeakerAudience.js';

export const RESOLUTION_PAGE_SIZE = 200;
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const valid = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !/^deleted_.*@deleted\.local$/i.test(value);
const memberColumns = 'id,email,first_name,last_name,communications_opted_out_all,login_enabled,organization_id';
async function rows(query) {
  const result = await query;
  if (result.error) throw preparationError(result.error);
  if (!Array.isArray(result.data)) throw new Error('Audience source did not return rows');
  return result.data;
}
async function one(query) {
  const result = await query.maybeSingle();
  if (result.error) throw preparationError(result.error);
  if (!result.data) throw new Error('Audience source is missing or inaccessible');
  return result.data;
}
function page(query, cursor, key = 'id') {
  if (cursor) query = query.gt(key, cursor);
  return rows(query.order(key, { ascending: true }).limit(RESOLUTION_PAGE_SIZE));
}
function memberRecipient(m) {
  return { ...m, member_id: m.id };
}
function fact(bucket, key, value = {}) { return { bucket, key, value }; }
function factsQuery(db, state, bucket) {
  return db.from('campaign_preparation_fact').select('key,value')
    .eq('generation', state.id).eq('segment', state.segment).eq('bucket', bucket);
}
async function factMap(db, state, bucket, keys) {
  if (!keys.length) return new Map();
  const found = await rows(factsQuery(db, state, bucket).in('key', [...new Set(keys)]));
  return new Map(found.map(row => [row.key, row.value]));
}
async function membersForEmails(db, tenantId, emails, trimMembers = false) {
  if (!emails.length) return new Map();
  // Bounded RPC output even when duplicate CRM identities are numerous.
  const result = await db.rpc('campaign_preparation_email_members', {
    p_tenant: tenantId, p_emails: [...new Set(emails.map(normalize))], p_trim: trimMembers,
  });
  if (result.error) throw preparationError(result.error);
  if (!Array.isArray(result.data)) throw new Error('Campaign email identity lookup returned invalid data');
  return new Map(result.data.map(row => [row.email_key, row]));
}
function policy(version) {
  if (!version) throw new Error('Survey historical response policy could not be verified');
  if (isEnhancedAnonymousSettings(version.survey_settings)) return 'anonymous';
  if (version.survey_settings?.response_identity === 'identified' &&
      version.survey_settings.anonymous_completion_version == null) return 'identified';
  throw new Error('Unsupported survey: anonymous or unknown historical policy lacks trustworthy identifiable completion evidence');
}

// One call performs ONE bounded state-machine transition. No historical arrays
// are replayed: version metadata, completion identities and predicate sets are
// indexed facts, and every source/working-set cursor is committed with its rows.
async function surveyChunk(db, state, work, bucket) {
  const tenant = state.tenant_id, s = work.s;
  const phase = work.phase || 'scope';
  if (phase === 'scope') {
    const scope = await validateEventSurveyScope(db, tenant, s);
    if (!scope) return { next: { ...work, phase: 'ordinary_scope' }, ordinary: true };
    return { next: { ...work, phase: 'versions', scope, cursor: null } };
  }
  const scope = work.scope;
  if (phase === 'versions') {
    const found = await page(db.from('survey_version').select('id,version_number,survey_settings')
      .eq('tenant_id', tenant).eq('form_id', scope.form.id), work.cursor);
    const current = found.find(v => v.version_number === Number(scope.form.survey_settings?.current_version));
    return { facts: found.map(v => fact(`${bucket}:versions`, v.id, v)),
      next: { ...work, current: current?.id || work.current,
        phase: found.length < RESOLUTION_PAGE_SIZE ? 'policy' : 'versions', cursor: found.at(-1)?.id || work.cursor } };
  }
  if (phase === 'policy') {
    const ids = [scope.assignment.survey_version_id,
      ...(scope.assignment.status === 'archived' ? [] : [work.current])];
    if (ids.some(id => !id)) throw new Error('Survey historical response policy could not be verified');
    const versions = await factMap(db, state, `${bucket}:versions`, ids);
    const policies = ids.map(id => policy(versions.get(id)));
    const enhanced = policies.includes('anonymous');
    return { next: { ...work, phase: 'metadata', cursor: null, enhanced } };
  }
  if (phase === 'metadata') {
    const found = await page(db.from('form_submission').select('id,survey_version_id,is_anonymous')
      .eq('tenant_id', tenant).eq('form_id', scope.form.id)
      .eq('survey_assignment_id', scope.assignment.id), work.cursor);
    const versions = await factMap(db, state, `${bucket}:versions`, found.map(r => r.survey_version_id).filter(Boolean));
    let enhanced = work.enhanced, anonymous = work.anonymous;
    const facts = [];
    for (const row of found) {
      const mode = policy(versions.get(row.survey_version_id));
      if ((mode === 'identified' && row.is_anonymous === true) ||
          (mode === 'anonymous' && row.is_anonymous !== true)) throw new Error('Survey response identity policy is inconsistent');
      if (mode === 'anonymous') { enhanced = true; anonymous = true; }
      else facts.push(fact(`${bucket}:identified`, row.id, { version: row.survey_version_id }));
    }
    return { facts, next: { ...work, enhanced, anonymous,
      phase: found.length < RESOLUTION_PAGE_SIZE ? 'ledger' : 'metadata',
      cursor: found.length < RESOLUTION_PAGE_SIZE ? null : found.at(-1).id } };
  }
  if (phase === 'ledger') {
    if (!work.enhanced) return { next: { ...work, phase: 'identities', cursor: null } };
    const found = await page(db.from('survey_completion').select(s.received ? 'id,recipient_email' : 'id')
      .eq('tenant_id', tenant).eq('form_id', scope.form.id).eq('assignment_id', scope.assignment.id), work.cursor);
    if (!s.received && (work.anonymous || found.length)) {
      throw new Error('No response is unsupported: anonymous completion evidence is missing a trustworthy completeness guarantee for historical responses; audience targeting stopped');
    }
    const facts = found.map(row => {
      const email = normalize(row.recipient_email);
      if (!valid(email)) throw new Error('Survey completion identity is unavailable');
      return fact(`${bucket}:emails`, email);
    });
    return { facts, next: { ...work, phase: found.length < RESOLUTION_PAGE_SIZE ? 'identities' : 'ledger',
      cursor: found.length < RESOLUTION_PAGE_SIZE ? null : found.at(-1).id } };
  }
  if (phase === 'identities') {
    const metadata = await page(factsQuery(db, state, `${bucket}:identified`), work.cursor, 'key');
    const found = metadata.length ? await rows(db.from('form_submission').select('id,survey_version_id,submitted_by_email')
      .eq('tenant_id', tenant).eq('form_id', scope.form.id).eq('survey_assignment_id', scope.assignment.id)
      .not('is_anonymous', 'is', true).in('id', metadata.map(row => row.key))) : [];
    const byId = new Map(found.map(row => [row.id, row]));
    const facts = metadata.map(row => {
      const source = byId.get(row.key), email = normalize(source?.submitted_by_email);
      if (source?.survey_version_id !== row.value.version || !valid(email)) {
        throw new Error('Unsupported survey: an identified response lacks trustworthy recipient identity');
      }
      return fact(`${bucket}:emails`, email);
    });
    return { facts, next: { ...work, phase: metadata.length < RESOLUTION_PAGE_SIZE ? 'bookings' : 'identities',
      cursor: metadata.length < RESOLUTION_PAGE_SIZE ? null : metadata.at(-1).key } };
  }
  if (phase === 'bookings') {
    const found = await page(db.from(scope.eventType === 'event' ? 'booking' : 'complex_event_booking')
      .select('id,attendee_email,attendee_first_name,attendee_last_name')
      .eq('tenant_id', tenant).eq('event_id', scope.eventId).eq('status', 'confirmed'), work.cursor);
    const emails = found.map(row => normalize(row.attendee_email)).filter(valid);
    const responded = await factMap(db, state, `${bucket}:emails`, emails);
    const selected = found.filter(row => valid(normalize(row.attendee_email)) &&
      responded.has(normalize(row.attendee_email)) === s.received);
    const members = await membersForEmails(db, tenant, selected.map(r => r.attendee_email));
    return { candidates: selected.map(row => {
      const email = normalize(row.attendee_email), member = members.get(email);
      return { email, member_id: member?.id || null, first_name: row.attendee_first_name || '',
        last_name: row.attendee_last_name || '', communications_opted_out_all: member?.any_opted_out === true };
    }), done: found.length < RESOLUTION_PAGE_SIZE, next: { ...work, cursor: found.at(-1)?.id } };
  }
  throw new Error(`Unknown survey preparation phase: ${phase}`);
}

async function normalChunk(db, state, work, bucket) {
  if (work.s.type === 'event_speakers') {
    const result = await speakerAudienceChunk(db, state.tenant_id, work.s, work.speakerCursor);
    return { candidates: result.candidates, done: result.done, next: { ...work, speakerCursor: result.cursor } };
  }
  const s = work.s, tenant = state.tenant_id, ids = s.ids || [];
  const members = () => db.from('member').select(memberColumns).eq('tenant_id', tenant)
    .not('email', 'ilike', 'deleted_%@deleted.local');
  if (['all_members', 'role', 'individual_members'].includes(s.type)) {
    let query = members();
    if (s.type === 'role') query = query.in('role_id', ids);
    if (s.type === 'individual_members') query = query.in('id', ids.slice(work.idOffset || 0, (work.idOffset || 0) + 200));
    const found = await page(query, work.cursor);
    const nextIds = s.type === 'individual_members' && found.length < 200 && (work.idOffset || 0) + 200 < ids.length;
    return { candidates: found.filter(r => r.email).map(memberRecipient),
      done: found.length < 200 && !nextIds,
      next: { ...work, cursor: nextIds ? null : found.at(-1)?.id,
        idOffset: nextIds ? (work.idOffset || 0) + 200 : work.idOffset } };
  }
  if (['member_group', 'member_group_admins'].includes(s.type)) {
    let query = db.from('member_group_assignment').select('id,member_id,expires_at,is_group_admin')
      .in('group_id', ids);
    if (s.type === 'member_group_admins') query = query.eq('is_group_admin', true);
    else if (Array.isArray(s.roles) && s.roles.length) query = query.in('group_role', s.roles);
    const found = await page(query, work.cursor);
    const selected = [...new Set(found.filter(r => r.member_id && (!r.expires_at ||
      new Date(r.expires_at).getTime() > new Date(state.snapshot.sent_at).getTime())).map(r => r.member_id))];
    const recipients = selected.length ? await rows(members().in('id', selected).order('id')) : [];
    return { candidates: recipients.filter(r => r.email).map(memberRecipient), done: found.length < 200,
      next: { ...work, cursor: found.at(-1)?.id } };
  }
  if (s.type === '_contacts') {
    const found = await page(db.from('audience_list_external_contact').select('id,email,first_name,last_name')
      .eq('tenant_id', tenant).eq('audience_list_id', ids[0]), work.cursor);
    return { candidates: found.map(r => ({ ...r, member_id: null })), done: found.length < 200,
      next: { ...work, cursor: found.at(-1)?.id } };
  }
  if (s.type === 'fundraisers' || s.type === 'donors') {
    let query = db.from(s.type === 'donors' ? 'fundraising_donation' : 'fundraising_team_member')
      .select('*').eq('tenant_id', tenant);
    if (s.type === 'donors') query = query.eq('payment_status', 'succeeded');
    if (!ids.includes('all') && ids.length) query = query.in('campaign_id', ids);
    const found = await page(query, work.cursor);
    return { candidates: found.map(r => s.type === 'donors' ? {
      email: r.donor_email, member_id: null, first_name: (r.donor_name || '').split(' ')[0],
      last_name: (r.donor_name || '').split(' ').slice(1).join(' '),
    } : { ...r, member_id: null }), done: found.length < 200, next: { ...work, cursor: found.at(-1)?.id } };
  }
  if (s.type === 'organisation') return { done: true }; // Existing resolver intentionally has no organisation branch.
  if (s.type === 'communication_category' || s.type === 'form') {
    const phase = work.phase || (s.type === 'form' ? 'forms' : 'preferences');
    if (phase === 'forms') {
      const found = await page(db.from('form').select('id,communication_category_id')
        .eq('tenant_id', tenant).in('id', ids), work.cursor);
      return { facts: found.flatMap(r => [fact(`${bucket}:forms`, r.id, r),
        ...(r.communication_category_id ? [fact(`${bucket}:categories`, r.communication_category_id)] : [])]),
      next: { ...work, phase: found.length < 200 ? 'preferences' : phase, cursor: found.length < 200 ? null : found.at(-1).id } };
    }
    if (phase === 'preferences') {
      let query = db.from('member_communication_preference').select('id,member_id,category_id')
        .eq('tenant_id', tenant).eq('is_subscribed', true);
      if (s.type === 'communication_category') query = query.in('category_id', ids);
      const found = await page(query, work.cursor);
      const categories = s.type === 'form'
        ? await factMap(db, state, `${bucket}:categories`, found.map(r => r.category_id).filter(Boolean)) : null;
      const selected = [...new Set(found.filter(r => !categories || categories.has(r.category_id)).map(r => r.member_id).filter(Boolean))];
      const resolved = selected.length ? await rows(members().in('id', selected).order('id')) : [];
      return { candidates: resolved.filter(r => r.email && r.login_enabled !== false).map(memberRecipient),
        next: { ...work, phase: found.length < 200 ? 'external' : phase, cursor: found.length < 200 ? null : found.at(-1).id } };
    }
    let query = db.from('email_subscriber').select('id,email,first_name,last_name,form_id,communication_category_id')
      .eq('tenant_id', tenant).eq('opted_out', false);
    if (s.type === 'communication_category') query = query.in('communication_category_id', ids);
    const found = await page(query, work.cursor);
    const forms = s.type === 'form' ? await factMap(db, state, `${bucket}:forms`, found.map(r => r.form_id).filter(Boolean)) : null;
    const selected = found.filter(r => !forms || (forms.has(r.form_id) &&
      Boolean(forms.get(r.form_id).communication_category_id) === (phase !== 'uncategorized')));
    const known = phase === 'uncategorized' ? new Map() : await membersForEmails(db, tenant, selected.map(r => r.email), true);
    const done = found.length < 200;
    return { candidates: selected.filter(r => !known.has(normalize(r.email))).map(r => ({ ...r, member_id: null })),
      done: done && (s.type !== 'form' || phase === 'uncategorized'),
      next: { ...work, phase: done && s.type === 'form' ? 'uncategorized' : phase,
        cursor: done ? null : found.at(-1).id } };
  }
  if (s.type === 'event_attendees' || (s.type === 'event_form' && work.ordinary)) {
    return eventChunk(db, state, work, bucket);
  }
  return null;
}

async function eventChunk(db, state, work, bucket) {
  const s = work.s, tenant = state.tenant_id;
  const ordinary = s.type === 'event_form';
  let phase = work.phase || 'regular';
  if (phase === 'ordinary_scope') {
    const form = await one(db.from('form').select('id,fields,is_event_related,related_event_id')
      .eq('tenant_id', tenant).eq('id', s.form_id || s.ids?.[0]));
    if (!form.is_event_related || !form.related_event_id) return { done: true };
    return { next: { ...work, form, phase: 'submissions', cursor: null } };
  }
  if (phase === 'submissions') {
    const found = await page(db.from('form_submission').select('id,submitted_by_email,submission_data')
      .eq('tenant_id', tenant).eq('form_id', work.form.id), work.cursor);
    const extract = row => {
      if (valid(normalize(row.submitted_by_email))) return normalize(row.submitted_by_email);
      const data = row.submission_data || {};
      for (const field of Array.isArray(work.form.fields) ? work.form.fields : []) {
        if (field?.id && (field.type === 'email' || /e-?mail/i.test(`${field.id} ${field.label || ''}`)) &&
            valid(normalize(data[field.id]))) return normalize(data[field.id]);
      }
      return Object.values(data).map(normalize).find(valid);
    };
    return { facts: found.map(extract).filter(Boolean).map(email => fact(`${bucket}:emails`, email)),
      next: { ...work, phase: found.length < 200 ? 'regular' : phase, cursor: found.length < 200 ? null : found.at(-1).id } };
  }
  if (phase === 'fallback') {
    const found = await page(factsQuery(db, state, `${bucket}:fallback`), work.cursor, 'key');
    const ids = found.map(r => r.key);
    const selected = ids.length ? await rows(db.from('member').select(memberColumns).eq('tenant_id', tenant)
      .in('id', ids).not('email', 'ilike', 'deleted_%@deleted.local').order('id')) : [];
    const evidence = ordinary ? await factMap(db, state, `${bucket}:emails`, selected.map(r => normalize(r.email))) : null;
    return { candidates: selected.filter(r => r.email && (!ordinary || evidence.has(normalize(r.email)) === s.received)).map(memberRecipient),
      done: found.length < 200, next: { ...work, cursor: found.at(-1)?.key } };
  }
  const complex = phase === 'complex';
  let query = db.from(complex ? 'complex_event_booking' : 'booking')
    .select('id,event_id,ticket_class_id,ticket_class_name,attendee_email,attendee_first_name,attendee_last_name,member_id' +
      (complex ? '' : ',checked_in_at'))
    .eq('tenant_id', tenant).eq('status', 'confirmed');
  query = ordinary ? query.eq('event_id', work.form.related_event_id) : query.in('event_id', s.ids || []);
  const found = await page(query, work.cursor);
  let selected = found;
  if (!ordinary) {
    selected = selected.filter(row => {
      const selection = s.ticket_type_selection?.[row.event_id];
      if (!Array.isArray(selection) || !selection.length) return true;
      if (!row.ticket_class_id && !row.ticket_class_name && selection.some(r => r.id === '__no_ticket_type__')) return true;
      return selection.filter(r => r.id !== '__no_ticket_type__').some(r =>
        (complex && r.id && r.id === row.ticket_class_id) ||
        (r.name && row.ticket_class_name?.toLowerCase() === r.name.toLowerCase()));
    });
    let attended = new Set();
    const ids = complex ? selected.filter(r => ['attended', 'not_attended'].includes(s.attendance_selection?.[r.event_id])).map(r => r.id) : [];
    if (ids.length) {
      const { data, error } = await db.rpc('campaign_preparation_attended_bookings', { p_tenant: tenant, p_ids: ids });
      if (error) throw preparationError(error);
      if (!Array.isArray(data)) throw new Error('Campaign attendance lookup returned invalid data');
      attended = new Set(data.map(r => r.booking_id));
    }
    selected = selected.filter(row => {
      const filter = s.attendance_selection?.[row.event_id];
      return !['attended', 'not_attended'].includes(filter) ||
        (complex ? attended.has(row.id) : Boolean(row.checked_in_at)) === (filter === 'attended');
    });
  }
  const facts = selected.filter(r => !(r.attendee_email || '').trim() && r.member_id)
    .map(r => fact(`${bucket}:fallback`, r.member_id));
  const direct = selected.filter(r => (r.attendee_email || '').trim() && !/^deleted_.*@deleted\.local$/i.test(r.attendee_email.trim()));
  const evidence = ordinary ? await factMap(db, state, `${bucket}:emails`, direct.map(r => normalize(r.attendee_email))) : null;
  const eligible = direct.filter(r => !ordinary || evidence.has(normalize(r.attendee_email)) === s.received);
  const members = await membersForEmails(db, tenant, eligible.map(r => r.attendee_email));
  return { facts, candidates: eligible.map(r => {
    const member = members.get(normalize(r.attendee_email));
    return member ? memberRecipient(member) : { email: r.attendee_email.trim(), member_id: null,
      first_name: r.attendee_first_name || '', last_name: r.attendee_last_name || '' };
  }), next: { ...work, phase: found.length < 200 ? (complex ? 'fallback' : 'complex') : phase,
    cursor: found.length < 200 ? null : found.at(-1).id } };
}

export async function resolvePreparationChunk({ db, state, extensions = {}, conditions }) {
  const root = state.snapshot.target_audiences?.length ? state.snapshot.target_audiences[state.segment]
    : { type: state.snapshot.target_type, ids: state.snapshot.target_ids || [] };
  const continuation = state.continuation || {};
  const stack = continuation.stack || [{ s: root, bypass: state.snapshot.ignore_opt_outs === true, ancestors: [], token: 'root' }];
  const work = stack[0], bucket = work.token;
  if (work.s.type === 'audience_list') {
    const ids = [...new Set(work.s.ids || [])].filter(id => !(work.ancestors || []).includes(id));
    if (!ids.length) return { continuation: { stack: stack.slice(1) }, done: stack.length === 1 };
    const list = await one(db.from('audience_list').select('id,target_audiences,ignore_opt_outs,category_review_required')
      .eq('tenant_id', state.tenant_id).eq('id', ids[0]));
    if (list.category_review_required) throw new Error('Audience list requires category review');
    const bypass = work.bypass || list.ignore_opt_outs === true;
    const children = [{ type: '_contacts', ids: [list.id] }, ...(list.target_audiences || [])]
      .map((s, i) => ({ s, bypass, ancestors: [...(work.ancestors || []), list.id], token: `${bucket}/${list.id}/${i}` }));
    return { continuation: { stack: [...children,
      ...(ids.length > 1 ? [{ ...work, s: { ...work.s, ids: ids.slice(1) } }] : []), ...stack.slice(1)] } };
  }
  let result;
  if (work.s.type === 'event_form' && work.phase !== 'ordinary_scope' && !work.ordinary) {
    result = await surveyChunk(db, state, work, bucket);
    if (result.ordinary) result = { ...result, next: { ...result.next, ordinary: true } };
  } else if (work.s.type === 'field_filter') result = await fieldChunk(db, state, work, bucket, conditions);
  else result = await normalChunk(db, state, work, bucket);
  if (!result && extensions[work.s.type]) result = await extensions[work.s.type]({ db, state, work, bucket });
  if (!result) throw new Error(`No resumable resolver for audience type ${work.s.type}`);
  if (['event_attendees','event_form'].includes(work.s.type) && result.candidates?.length) {
    // These legacy segment resolvers choose the attendee/member identity
    // before consent is applied. A later duplicate must not replace an
    // opted-out first identity (including a fallback purchaser identity).
    const seenBucket = `${bucket}:recipient-seen`;
    const seen = new Set((await factMap(db, state, seenBucket,
      result.candidates.map(r => r.email?.toLowerCase()).filter(Boolean))).keys());
    const additions = [];
    result.candidates = result.candidates.filter(r => {
      const key = r.email?.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key); additions.push(fact(seenBucket,key)); return true;
    });
    result.facts = [...(result.facts || []),...additions];
  }
  const next = result.done ? stack.slice(1) : [result.next || work, ...stack.slice(1)];
  return { facts: result.facts || [], candidates: (result.candidates || []).filter(r => r.email &&
    !/^deleted_.*@deleted\.local$/i.test(r.email)).map(r => ({ ...r, bypass_opt_out: work.bypass === true })),
  continuation: { stack: next }, done: next.length === 0 };
}

async function fieldChunk(db, state, work, bucket, helpers) {
  if (!helpers) throw new Error('Field-filter preparation helpers are unavailable');
  const tenant = state.tenant_id;
  if (!work.phase) {
    const custom = (work.s.filter_groups || []).flatMap(g => g.conditions || []).filter(c => c.entity_scope === 'custom_object');
    const selectedMetadata = {
      custom_object_definition: ['id', [...new Set(custom.map(c => c.custom_object_id))]],
      custom_object_relationship_definition: ['id', [...new Set(custom.map(c => c.relationship_definition_id))]],
      preference_field: ['id', [...new Set(custom.filter(c => c.field_type === 'record').map(c => c.field_id))]],
    };
    const metadataDb = { from: table => ({
      select: (...args) => {
        if (!selectedMetadata[table]) throw new Error('Unexpected custom-object preparation metadata source');
        return db.from(table).select(...args).in(...selectedMetadata[table]);
      },
    }) };
    const metadata = custom.length ? await discoverAudienceCustomObjects(metadataDb, tenant) : [];
    custom.forEach(c => validateCustomObjectCondition(c, metadata));
    const operators = new Set(['equals','not_equals','contains','is_empty','is_not_empty','is_true','is_false','greater_than','less_than','before','after','is_one_of','is_not_one_of']);
    const memberKeys = new Set(['first_name','last_name','email','job_title','role_id','login_enabled','communications_opted_out_all']);
    const groups = [];
    for (const group of work.s.filter_groups || []) {
      const predicates = [], customSelections = new Map();
      for (const c of group.conditions || []) {
        if (c.entity_scope === 'custom_object') {
          const key = customObjectSelectionKey(c);
          if (!customSelections.has(key)) customSelections.set(key, []);
          customSelections.get(key).push(c);
          continue;
        }
        if (!operators.has(c.operator)) continue;
        if (c.entity_scope === 'event') {
          const ids = Array.isArray(c.value) ? c.value : c.value ? [c.value] : [];
          if (c.field_key === 'attended_event' && ['is_one_of','is_not_one_of'].includes(c.operator) && ids.length) {
            predicates.push({ ...c, ids });
          }
        } else if (['member','organization'].includes(c.entity_scope) && ['core','custom'].includes(c.field_type)) {
          if (c.field_type === 'core' && !(c.entity_scope === 'member' ? memberKeys.has(c.field_key) : ['name','status'].includes(c.field_key))) continue;
          predicates.push(c);
        }
      }
      for (const predicatesForSelection of customSelections.values()) predicates.push({
        entity_scope: 'custom_object', predicates: predicatesForSelection,
      });
      if (predicates.length) groups.push(predicates);
    }
    return { done: !groups.length, next: { ...work, groups, phase: 'predicates', group: 0, condition: 0, cursor: null } };
  }
  const groups = work.groups, group = work.group || 0, condition = work.condition || 0;
  if (work.phase === 'predicates') {
    const c = groups[group][condition], name = `${bucket}:g${group}:c${condition}`;
    let found, facts = [], finish, next = { ...work }, cursorKey = 'id';
    if (c.entity_scope === 'custom_object') {
      const first = c.predicates[0], objectSide = `${first.object_side}_record_id`;
      const memberSide = first.object_side === 'source' ? 'target_record_id' : 'source_record_id';
      found = await page(db.from('custom_object_relationship').select('id,source_record_id,target_record_id,field_values')
        .eq('tenant_id', tenant).eq('relationship_definition_id', first.relationship_definition_id).is('archived_at', null), work.cursor);
      const ids = [...new Set(found.map(r => r[objectSide]))].filter(Boolean);
      const records = ids.length ? await rows(db.from('custom_object_record').select('id,data')
        .eq('tenant_id', tenant).eq('custom_object_id', first.custom_object_id).is('archived_at', null).in('id', ids)) : [];
      const byId = new Map(records.map(r => [r.id,r]));
      facts = found.filter(edge => byId.has(edge[objectSide]) && c.predicates.every(p => matchesCustomObjectValue(
        (p.field_type === 'record' ? byId.get(edge[objectSide]).data : edge.field_values)?.[p.field_key], p)))
        .map(edge => fact(name, edge[memberSide]));
    } else if (c.entity_scope === 'event') {
      const complex = work.source === 'complex';
      found = await page(db.from(complex ? 'complex_event_booking' : 'booking')
        .select('id,attendee_email,member_id').eq('tenant_id', tenant).eq('status', 'confirmed').in('event_id', c.ids), work.cursor);
      facts = found.flatMap(r => {
        const email = normalize(r.attendee_email);
        return email ? [fact(`${name}:emails`, email)] : r.member_id ? [fact(name,r.member_id)] : [];
      });
      if (found.length < 200 && !complex) {
        return { facts, next: { ...work, source: 'complex', cursor: null } };
      }
    } else if (c.field_type === 'core') {
      let query = db.from(c.entity_scope).select('id').eq('tenant_id', tenant);
      if (c.entity_scope === 'member') query = query.not('email','ilike','deleted_%@deleted.local');
      query = helpers.applyConditionToQuery(query,c.field_key,c.operator,c.value,c.data_type);
      found = await page(query,work.cursor);
      facts = found.map(r => fact(name,r.id));
    } else {
      const column = `${c.entity_scope}_id`;
      // Preference values are uniquely keyed by (entity_id, field_id); do not
      // assume these tables have a surrogate id.
      cursorKey = column;
      let query = db.from(`${c.entity_scope}_preference_value`).select(`${column},value`).eq('field_id',c.field_key);
      let postFilter;
      if (c.operator === 'is_empty') query = query.not('value','is',null).neq('value','').neq('value','[]');
      else ({ query, postFilter } = helpers.applyPrefValueCondition(query,c.operator,c.value,c.data_type));
      found = await page(query,work.cursor,column);
      facts = (postFilter ? postFilter(found) : found).map(r => fact(name,r[column]));
    }
    finish = found.length < 200;
    if (finish) {
      let g = group, p = condition + 1;
      if (p >= groups[g].length) { g++; p = 0; }
      next = { ...work, group:g,condition:p,cursor:null,source:null,
        phase:g >= groups.length ? 'members' : 'predicates' };
    } else next.cursor = found.at(-1)[cursorKey];
    return { facts:facts.filter(r=>r.key), next };
  }
  if (work.phase === 'members') {
    const found = await page(db.from('member').select(memberColumns).eq('tenant_id',tenant)
      .not('email','ilike','deleted_%@deleted.local'),work.memberCursor);
    if (!found.length) return {done:true};
    return { next:{...work,phase:'evaluate',members:found,group:0,condition:0,
      groupMatches:found.map(()=>true),union:found.map(()=>false),lastPage:found.length<200} };
  }
  if (work.phase === 'evaluate') {
    const c=groups[group][condition], name=`${bucket}:g${group}:c${condition}`;
    const keys=work.members.map(r=>c.entity_scope==='organization'?r.organization_id:r.id).filter(Boolean);
    const matches=await factMap(db,state,name,keys);
    const emailMatches=c.entity_scope==='event'
      ? await factMap(db,state,`${name}:emails`,work.members.map(r=>r.email?.toLowerCase()).filter(Boolean)) : null;
    const groupMatches=work.groupMatches.map((previous,i)=>{
      const m=work.members[i];
      let matched=matches.has(c.entity_scope==='organization'?m.organization_id:m.id) ||
        (emailMatches?.has(m.email?.toLowerCase()) || false);
      if ((c.field_type==='custom' && c.operator==='is_empty') ||
          (c.entity_scope==='event' && c.operator==='is_not_one_of')) matched=!matched;
      // Organization predicates never match members with no organization,
      // including custom-value "is empty".
      if (c.entity_scope==='organization' && !m.organization_id) matched=false;
      return previous && matched;
    });
    let g=group,p=condition+1,union=work.union;
    if(p>=groups[g].length){ union=union.map((v,i)=>v||groupMatches[i]);g++;p=0; }
    if(g>=groups.length) return {candidates:work.members.filter((r,i)=>union[i]&&r.email).map(memberRecipient),
      done:work.lastPage,next:{...work,phase:'members',members:undefined,groupMatches:undefined,union:undefined,
        memberCursor:work.members.at(-1).id}};
    return {next:{...work,group:g,condition:p,union,groupMatches:p===0?work.members.map(()=>true):groupMatches}};
  }
  throw new Error('Unknown field-filter continuation');
}