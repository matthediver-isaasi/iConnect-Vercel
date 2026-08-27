/**
 * GET /api/admin/email-placeholder-dd-submission
 *
 * Returns either:
 *   - ?search=<text>    -> { results: [{ id, application_uid, form_name, status,
 *                                         organization_name, member_name }] }
 *                          (capped at 25) for typeahead in the Email Placeholders
 *                          Due Diligence picker.
 *   - ?lookup=<text>    -> full bundle for one DD submission. The lookup value
 *                          is matched first as a DD-row id (uuid), then as a
 *                          form_submission id (uuid), then as an application_uid.
 *
 * Bundle shape (mirrors what `buildCategorySample('Due Diligence', record)`
 * expects on the client):
 *   {
 *     id, form_name, status, stage, score, risk_level, review_date,
 *     reviewer, owner, owner_email,
 *     submission: { id, application_uid, workflow_status,
 *                   due_diligence_score, risk_level },
 *     _bundle: {
 *       organization: { id, name, invoicing_email, phone },
 *       member:       { id, first_name, last_name, full_name, email, phone },
 *       owner:        { id, full_name, email },
 *       reviewer:     { id, full_name, email },
 *       meeting:      { id, type, duration, title, date, time,
 *                       attendee_name, attendee_email,
 *                       zoom_join_url, teams_join_url } | null,
 *       formFields:   [ { id, label, type } ],
 *       formValues:   { byId: { [field_id]: value },
 *                       byLabel: { [label]: value } }
 *     }
 *   }
 *
 * Hard-fails (403) any request that arrives without a usable tenant context
 * or whose target submission belongs to a different tenant. Admin-only.
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import {
  collectRelationshipRecordIds,
  formatRelationshipDisplayValue,
  getSubmissionRelationshipValue,
  isRelationshipDropdownField,
  loadTenantRelationshipDisplayLabels,
} from '../_lib/relationshipDisplayLabels.js';

const SEARCH_LIMIT = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatDateTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

function formatDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return null;
  }
}

function flattenFields(form) {
  if (!form) return [];
  const out = [];
  if (Array.isArray(form.fields)) out.push(...form.fields);
  if (Array.isArray(form.pages)) {
    for (const page of form.pages) {
      if (Array.isArray(page?.fields)) out.push(...page.fields);
    }
  }
  return out.filter((f) => f && f.id);
}

function stringifyFieldValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(stringifyFieldValue).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if (value.full_name) return value.full_name;
    if (value.name) return value.name;
    if (value.email) return value.email;
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

export function buildDdSubmissionFieldValues(fields, submissionData, relationshipLabelsByRecordId) {
  const byId = {};
  const byLabel = {};
  for (const field of fields || []) {
    const raw = isRelationshipDropdownField(field)
      ? getSubmissionRelationshipValue(submissionData, field)
      : (
        submissionData?.[field.id]
        ?? (field.label ? submissionData?.[field.label] : undefined)
        ?? (field.name ? submissionData?.[field.name] : undefined)
      );
    const display = isRelationshipDropdownField(field)
      ? formatRelationshipDisplayValue(raw, relationshipLabelsByRecordId)
      : stringifyFieldValue(raw);
    if (display !== '') {
      byId[field.id] = display;
      const label = field.label || field.name;
      if (label) byLabel[label] = display;
    }
  }
  return { byId, byLabel };
}

function memberToBundle(m) {
  if (!m) return null;
  const fullName = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || '';
  return {
    id: m.id,
    first_name: m.first_name || '',
    last_name: m.last_name || '',
    full_name: fullName,
    email: m.email || '',
    phone: m.mobile || m.phone || '',
  };
}

async function fetchMembersByIds(tenantId, ids) {
  const clean = Array.from(new Set(ids.filter(Boolean)));
  if (clean.length === 0) return {};
  const { data } = await supabase
    .from('member')
    .select('id, first_name, last_name, email, mobile, tenant_id')
    .in('id', clean)
    .eq('tenant_id', tenantId);
  const out = {};
  for (const row of data || []) out[row.id] = memberToBundle(row);
  return out;
}

async function fetchMemberByEmail(tenantId, email) {
  if (!email) return null;
  const { data } = await supabase
    .from('member')
    .select('id, first_name, last_name, email, mobile, tenant_id')
    .eq('tenant_id', tenantId)
    .ilike('email', email)
    .limit(1)
    .maybeSingle();
  return memberToBundle(data);
}

/**
 * Look up a tenant_user (platform-level operator) by id or email. Used for
 * DD owner/reviewer when they're not a member of the tenant.
 */
async function fetchTenantUserByEmail(tenantId, email) {
  if (!email) return null;
  const { data } = await supabase
    .from('tenant_user')
    .select('id, first_name, last_name, email, tenant_id')
    .eq('tenant_id', tenantId)
    .ilike('email', email)
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    first_name: data.first_name || '',
    last_name: data.last_name || '',
    full_name:
      [data.first_name, data.last_name].filter(Boolean).join(' ') || data.email || '',
    email: data.email || '',
    phone: '',
  };
}

async function fetchLatestMeeting(tenantId, formSubmissionId) {
  if (!formSubmissionId) return null;
  const { data, error } = await supabase
    .from('dd_meeting_request')
    .select(
      'id, recipient_email, recipient_first_name, recipient_last_name, status, ' +
        'sent_at, created_at, agent_booking_id, ' +
        'meeting_template:meeting_template_id(id, name, duration_minutes)',
    )
    .eq('tenant_id', tenantId)
    .eq('form_submission_id', formSubmissionId)
    .order('sent_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;

  // If a booking has been linked, pull its scheduled time + meeting URL so
  // tokens like {{meeting_date}}, {{zoom_join_url}}, {{teams_join_url}}
  // resolve against real values.
  let booking = null;
  if (data.agent_booking_id) {
    const { data: bk } = await supabase
      .from('agent_booking')
      .select('id, start_time, end_time, meeting_url, tenant_id')
      .eq('id', data.agent_booking_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    booking = bk || null;
  }

  const tpl = data.meeting_template || {};
  const attendeeName =
    [data.recipient_first_name, data.recipient_last_name].filter(Boolean).join(' ') ||
    data.recipient_email ||
    'Attendee';
  const startIso = booking?.start_time || data.sent_at || null;
  const dt = startIso ? new Date(startIso) : null;
  const meetingUrl = booking?.meeting_url || '';
  const isTeams = /teams\.microsoft\.com|teams\.live\.com/i.test(meetingUrl);
  const isZoom = /zoom\.us|zoomgov\.com/i.test(meetingUrl);
  return {
    id: data.id,
    type: tpl.name || 'Meeting',
    duration: tpl.duration_minutes ? `${tpl.duration_minutes} minutes` : null,
    title: `${tpl.name || 'Meeting'} with ${attendeeName}`,
    date: dt ? formatDate(startIso) : null,
    time: dt
      ? dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : null,
    attendee_name: attendeeName,
    attendee_email: data.recipient_email || '',
    zoom_join_url: isZoom ? meetingUrl : '',
    teams_join_url: isTeams ? meetingUrl : '',
  };
}

async function loadDdBundle(tenantId, ddRow) {
  // Form submission (with !inner tenant guard)
  let formSubmission = null;
  if (ddRow.form_submission_id) {
    const { data } = await supabase
      .from('form_submission')
      .select(
        'id, form_id, submission_data, organization_id, member_id, created_member_id, ' +
          'created_organization_id, tenant_id',
      )
      .eq('id', ddRow.form_submission_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    formSubmission = data || null;
  }

  // Form definition (for fields)
  let form = null;
  if (formSubmission?.form_id) {
    const { data } = await supabase
      .from('form')
      .select('id, name, fields, pages, tenant_id')
      .eq('id', formSubmission.form_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    form = data || null;
  }

  const fieldDefinitions = flattenFields(form);
  const formFields = fieldDefinitions.map((f) => ({
    id: f.id,
    label: f.label || f.name || '',
    type: f.type || '',
  }));

  const submissionData = formSubmission?.submission_data || {};
  const relationshipLabelsByRecordId = await loadTenantRelationshipDisplayLabels(
    supabase,
    tenantId,
    collectRelationshipRecordIds(fieldDefinitions, submissionData),
  );
  const { byId, byLabel } = buildDdSubmissionFieldValues(
    fieldDefinitions,
    submissionData,
    relationshipLabelsByRecordId,
  );

  // Organisation
  let organization = null;
  const orgId =
    formSubmission?.created_organization_id || formSubmission?.organization_id || null;
  if (orgId) {
    const { data } = await supabase
      .from('organization')
      .select('id, name, invoicing_email, phone, tenant_id')
      .eq('id', orgId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (data) {
      organization = {
        id: data.id,
        name: data.name || '',
        invoicing_email: data.invoicing_email || '',
        phone: data.phone || '',
      };
    }
  }

  // Submitting member
  const memberId =
    formSubmission?.created_member_id || formSubmission?.member_id || null;
  const memberMap = await fetchMembersByIds(
    tenantId,
    [memberId, ddRow.owner_member_id].filter(Boolean),
  );
  const member = memberId ? memberMap[memberId] || null : null;

  // DD owner: try member by id first; if there's no matching member but we
  // have an owner_name that looks like an email, try tenant_user; finally
  // fall back to a plain name-only stub.
  let owner = ddRow.owner_member_id ? memberMap[ddRow.owner_member_id] || null : null;
  if (!owner && ddRow.owner_name) {
    const ownerLooksLikeEmail = /@/.test(ddRow.owner_name);
    if (ownerLooksLikeEmail) {
      owner = await fetchTenantUserByEmail(tenantId, ddRow.owner_name);
    }
    if (!owner) {
      owner = {
        id: null,
        full_name: ddRow.owner_name,
        email: ownerLooksLikeEmail ? ddRow.owner_name : '',
        first_name: '',
        last_name: '',
        phone: '',
      };
    }
  }

  // Reviewer (reviewed_by stored as email string). Try member, then
  // tenant_user, then fall back to the raw email.
  let reviewer = null;
  if (ddRow.reviewed_by) {
    reviewer =
      (await fetchMemberByEmail(tenantId, ddRow.reviewed_by)) ||
      (await fetchTenantUserByEmail(tenantId, ddRow.reviewed_by)) || {
        id: null,
        full_name: ddRow.reviewed_by,
        email: ddRow.reviewed_by,
        first_name: '',
        last_name: '',
        phone: '',
      };
  }

  // Latest meeting request
  const meeting = await fetchLatestMeeting(tenantId, ddRow.form_submission_id);

  return {
    id: ddRow.id,
    form_name: form?.name || 'Due Diligence Form',
    status: ddRow.workflow_status || '',
    stage: ddRow.workflow_status || '',
    score: ddRow.due_diligence_score ?? null,
    risk_level: ddRow.risk_level || '',
    review_date: formatDateTime(ddRow.reviewed_date),
    reviewer: reviewer?.full_name || ddRow.reviewed_by || '',
    owner: owner?.full_name || ddRow.owner_name || '',
    owner_email: owner?.email || '',
    submission: {
      id: ddRow.form_submission_id,
      application_uid: ddRow.application_uid || '',
      workflow_status: ddRow.workflow_status || '',
      due_diligence_score: ddRow.due_diligence_score ?? null,
      risk_level: ddRow.risk_level || '',
    },
    _bundle: {
      organization,
      member,
      owner,
      reviewer,
      meeting,
      formFields,
      formValues: { byId, byLabel },
    },
  };
}

async function findDdRow(tenantId, lookup) {
  const trimmed = (lookup || '').trim();
  if (!trimmed) return null;

  const baseSelect =
    'id, form_submission_id, application_uid, workflow_status, due_diligence_score, ' +
    'risk_level, reviewed_by, reviewed_date, owner_member_id, owner_name, tenant_id';

  // 1. Try as DD row id
  if (UUID_RE.test(trimmed)) {
    const { data: byId } = await supabase
      .from('form_submission_due_diligence')
      .select(baseSelect)
      .eq('id', trimmed)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (byId) return byId;

    // 2. Try as form_submission id
    const { data: bySub } = await supabase
      .from('form_submission_due_diligence')
      .select(baseSelect)
      .eq('form_submission_id', trimmed)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (bySub) return bySub;
  }

  // 3. Try as application_uid (case-insensitive exact match)
  const { data: byUid } = await supabase
    .from('form_submission_due_diligence')
    .select(baseSelect)
    .eq('tenant_id', tenantId)
    .ilike('application_uid', trimmed)
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (byUid) return byUid;

  return null;
}

async function searchDdRows(tenantId, query) {
  const trimmed = (query || '').trim();
  const isUuidQuery = trimmed && UUID_RE.test(trimmed);
  const escape = (s) => s.replace(/[%,()]/g, '');

  // Strategy: build a set of candidate form_submission_ids and/or DD row ids
  // entirely server-side, then fetch the matching DD rows.
  //   - No query: just take recent N DD rows.
  //   - UUID query: match DD id directly OR application_uid contains it.
  //   - Free-text: parallel queries against form_submission_due_diligence
  //     (application_uid), organization (name), member (name/email), and
  //     form (name) -> resolve to form_submission_ids -> intersect with
  //     tenant-scoped DD rows. Each lookup is itself tenant-scoped so we
  //     never leak ids across tenants.
  let baseQ = supabase
    .from('form_submission_due_diligence')
    .select(
      'id, form_submission_id, application_uid, workflow_status, ' +
        'due_diligence_score, risk_level, updated_at',
    )
    .eq('tenant_id', tenantId);

  if (isUuidQuery) {
    baseQ = baseQ.or(`application_uid.ilike.%${escape(trimmed)}%,id.eq.${trimmed}`);
  } else if (trimmed) {
    const term = `%${escape(trimmed)}%`;

    const [{ data: orgRows }, { data: memberRows }, { data: formRows }] = await Promise.all([
      supabase
        .from('organization')
        .select('id')
        .eq('tenant_id', tenantId)
        .ilike('name', term)
        .limit(200),
      supabase
        .from('member')
        .select('id')
        .eq('tenant_id', tenantId)
        .or(`first_name.ilike.${term},last_name.ilike.${term},email.ilike.${term}`)
        .limit(200),
      supabase
        .from('form')
        .select('id')
        .eq('tenant_id', tenantId)
        .ilike('name', term)
        .limit(200),
    ]);

    const orgIdsRaw = (orgRows || []).map((r) => r.id);
    const memberIdsRaw = (memberRows || []).map((r) => r.id);
    const formIdsRaw = (formRows || []).map((r) => r.id);

    const submissionIdSet = new Set();
    if (orgIdsRaw.length || memberIdsRaw.length || formIdsRaw.length) {
      const orParts = [];
      if (orgIdsRaw.length) {
        orParts.push(`organization_id.in.(${orgIdsRaw.join(',')})`);
        orParts.push(`created_organization_id.in.(${orgIdsRaw.join(',')})`);
      }
      if (memberIdsRaw.length) {
        orParts.push(`member_id.in.(${memberIdsRaw.join(',')})`);
        orParts.push(`created_member_id.in.(${memberIdsRaw.join(',')})`);
      }
      if (formIdsRaw.length) {
        orParts.push(`form_id.in.(${formIdsRaw.join(',')})`);
      }
      const { data: subRows } = await supabase
        .from('form_submission')
        .select('id')
        .eq('tenant_id', tenantId)
        .or(orParts.join(','))
        .limit(500);
      for (const row of subRows || []) submissionIdSet.add(row.id);
    }

    const orParts = [
      `application_uid.ilike.${term}`,
      `workflow_status.ilike.${term}`,
    ];
    if (submissionIdSet.size > 0) {
      orParts.push(`form_submission_id.in.(${Array.from(submissionIdSet).join(',')})`);
    }
    baseQ = baseQ.or(orParts.join(','));
  }

  baseQ = baseQ
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(SEARCH_LIMIT);

  const { data: ddRows, error } = await baseQ;
  if (error) {
    console.warn('[email-placeholder-dd-submission] search error:', error.message);
    return [];
  }
  if (!ddRows || ddRows.length === 0) return [];

  // Hydrate display labels (form name, org name, member name) for each row.
  const submissionIds = Array.from(
    new Set(ddRows.map((r) => r.form_submission_id).filter(Boolean)),
  );
  const submissionToForm = {};
  const submissionToOrg = {};
  const submissionToMember = {};
  if (submissionIds.length > 0) {
    const { data: subRows } = await supabase
      .from('form_submission')
      .select(
        'id, form_id, organization_id, created_organization_id, member_id, created_member_id, tenant_id',
      )
      .in('id', submissionIds)
      .eq('tenant_id', tenantId);
    for (const row of subRows || []) {
      submissionToForm[row.id] = row.form_id;
      submissionToOrg[row.id] = row.created_organization_id || row.organization_id || null;
      submissionToMember[row.id] = row.created_member_id || row.member_id || null;
    }
  }

  const formIds = Array.from(new Set(Object.values(submissionToForm).filter(Boolean)));
  const formNames = {};
  if (formIds.length > 0) {
    const { data: formRows } = await supabase
      .from('form')
      .select('id, name, tenant_id')
      .in('id', formIds)
      .eq('tenant_id', tenantId);
    for (const row of formRows || []) formNames[row.id] = row.name;
  }

  const orgIds = Array.from(new Set(Object.values(submissionToOrg).filter(Boolean)));
  const orgNames = {};
  if (orgIds.length > 0) {
    const { data: orgRows } = await supabase
      .from('organization')
      .select('id, name, tenant_id')
      .in('id', orgIds)
      .eq('tenant_id', tenantId);
    for (const row of orgRows || []) orgNames[row.id] = row.name;
  }

  const memberIds = Array.from(new Set(Object.values(submissionToMember).filter(Boolean)));
  const memberNames = {};
  if (memberIds.length > 0) {
    const { data: memberRows } = await supabase
      .from('member')
      .select('id, first_name, last_name, email, tenant_id')
      .in('id', memberIds)
      .eq('tenant_id', tenantId);
    for (const row of memberRows || []) {
      memberNames[row.id] =
        [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || '';
    }
  }

  return ddRows.map((r) => {
    const subId = r.form_submission_id;
    return {
      id: r.id,
      application_uid: r.application_uid || '',
      form_name: formNames[submissionToForm[subId]] || 'Due Diligence Form',
      status: r.workflow_status || '',
      organization_name: orgNames[submissionToOrg[subId]] || '',
      member_name: memberNames[submissionToMember[subId]] || '',
    };
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await getTenantContext(req);
  if (!ctx || !ctx.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const tenantId = ctx.tenantId;
  if (!tenantId) {
    return res.status(403).json({ error: 'Invalid tenant context' });
  }
  const isAdmin = await hasAdminAccess(ctx);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { search, lookup } = req.query;

    if (typeof lookup === 'string' && lookup.trim()) {
      const ddRow = await findDdRow(tenantId, lookup);
      if (!ddRow) {
        return res.status(404).json({ error: 'No Due Diligence submission found' });
      }
      const bundle = await loadDdBundle(tenantId, ddRow);
      return res.status(200).json({ submission: bundle });
    }

    const results = await searchDdRows(tenantId, typeof search === 'string' ? search : '');
    return res.status(200).json({ results });
  } catch (err) {
    console.error('[email-placeholder-dd-submission] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
