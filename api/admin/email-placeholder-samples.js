/**
 * GET /api/admin/email-placeholder-samples
 *
 * Returns sample data used by the Email Placeholders reference page to render
 * a live preview of how each placeholder resolves.
 *
 * Returns both:
 *   - Top-level "most recent of each" fields (member, organization, event,
 *     booking, contract, meeting, due_diligence) for backward compatibility /
 *     default view.
 *   - Lists per kind (members[], organizations[], events[] with their most
 *     recent booking attached, contracts[], meetings[],
 *     due_diligence_submissions[]) — capped at ~25 most-recent rows so the
 *     page can offer a per-section record picker. Optional/may-not-exist
 *     tables (meetings, due diligence) are wrapped in try/catch and resolve
 *     to an empty array on error rather than failing the whole response.
 *
 * Auth: requires an authenticated context with admin access (tenant user or
 * member whose role has admin permissions). Non-admin members are rejected
 * because the response includes tenant-wide PII (member email, booking
 * attendee info, contract signer details) intended for template authors.
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

const LIST_LIMIT = 25;

function formatEventDate(iso) {
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

function buildMember(m) {
  if (!m) return null;
  const fullName = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email;
  return {
    id: m.id,
    first_name: m.first_name,
    last_name: m.last_name,
    full_name: fullName,
    email: m.email,
    phone: m.mobile,
  };
}

function buildOrg(o) {
  if (!o) return null;
  return {
    id: o.id,
    name: o.name,
    invoicing_email: o.invoicing_email,
    phone: o.phone,
  };
}

function buildEvent(e) {
  if (!e) return null;
  return {
    id: e.id,
    title: e.title,
    name: e.title,
    date: formatEventDate(e.start_date),
    location: e.is_online ? 'Online Event' : e.location,
  };
}

function buildBooking(b) {
  if (!b) return null;
  return {
    id: b.id,
    reference: b.booking_reference,
    ticket_class: b.ticket_class_name || 'Standard',
  };
}

function buildAttendee(b) {
  if (!b) return null;
  if (!b.attendee_first_name && !b.attendee_last_name && !b.attendee_email) return null;
  return {
    first_name: b.attendee_first_name,
    last_name: b.attendee_last_name,
    email: b.attendee_email,
  };
}

function buildContract(ci) {
  if (!ci) return null;
  const signers = Array.isArray(ci.signers) ? ci.signers : [];
  const firstSigner = signers[0] || {};
  const signerName =
    firstSigner.full_name ||
    [firstSigner.first_name, firstSigner.last_name].filter(Boolean).join(' ') ||
    firstSigner.email ||
    'Contract signer';

  let daysSinceSent = null;
  if (ci.sent_at) {
    const sent = new Date(ci.sent_at).getTime();
    if (!Number.isNaN(sent)) {
      daysSinceSent = Math.max(0, Math.floor((Date.now() - sent) / (1000 * 60 * 60 * 24)));
    }
  }

  const out = {
    id: ci.id,
    signer: {
      first_name: firstSigner.first_name || null,
      last_name: firstSigner.last_name || null,
      full_name: signerName,
      email: firstSigner.email || null,
    },
  };
  if (daysSinceSent !== null) out.days_since_sent = daysSinceSent;
  const formName = ci.form?.name;
  if (formName) out.name = formName;
  return out;
}

function buildMeeting(req) {
  if (!req) return null;
  const tpl = req.meeting_template || {};
  const attendeeName =
    [req.recipient_first_name, req.recipient_last_name].filter(Boolean).join(' ') ||
    req.recipient_email ||
    'Attendee';
  const dt = req.booked_at ? new Date(req.booked_at) : null;
  const date = dt ? formatEventDate(req.booked_at) : null;
  const time = dt
    ? dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : null;
  const titleStem = tpl.name || 'Meeting';
  return {
    id: req.id,
    type: tpl.name || 'Meeting',
    duration: tpl.duration_minutes ? `${tpl.duration_minutes} minutes` : null,
    title: `${titleStem} with ${attendeeName}`,
    date,
    time,
    attendee_name: attendeeName,
    attendee_email: req.recipient_email,
  };
}

function buildDdSubmission(row) {
  if (!row) return null;
  const sub = row.form_submission || {};
  const formName = sub.form?.name;
  return {
    id: row.id,
    form_name: formName || 'Due Diligence Form',
    status: row.workflow_status,
    stage: row.workflow_status,
    score: row.due_diligence_score,
    risk_level: row.risk_level,
    review_date: formatDateTime(row.reviewed_date),
    reviewer: row.reviewed_by || null,
    submission: {
      id: row.form_submission_id,
      application_uid: row.application_uid,
      workflow_status: row.workflow_status,
      due_diligence_score: row.due_diligence_score,
      risk_level: row.risk_level,
    },
  };
}

async function fetchOptional(promise, label) {
  try {
    const res = await promise;
    if (res?.error) {
      console.warn(`[email-placeholder-samples] ${label} query error:`, res.error.message || res.error);
      return [];
    }
    return Array.isArray(res?.data) ? res.data : [];
  } catch (err) {
    console.warn(`[email-placeholder-samples] ${label} threw:`, err?.message || err);
    return [];
  }
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
    return res.status(200).json({ source: 'fixture', tenantId });
  }

  const result = {
    source: 'real',
    sources: {},
    tenantId,
    members: [],
    organizations: [],
    events: [],
    contracts: [],
    meetings: [],
    due_diligence_submissions: [],
  };

  try {
    const [
      tenantRes,
      membersRes,
      orgsRes,
      eventsRes,
      latestBookingRes,
      contractsRes,
      meetingsRows,
      ddRows,
    ] = await Promise.all([
      supabase.from('tenant').select('id, name').eq('id', tenantId).maybeSingle(),
      supabase
        .from('member')
        .select('id, first_name, last_name, email, mobile, organization_id, created_on')
        .eq('tenant_id', tenantId)
        .not('email', 'like', 'deleted_%@deleted.local')
        .order('created_on', { ascending: false })
        .limit(LIST_LIMIT),
      supabase
        .from('organization')
        .select('id, name, invoicing_email, phone')
        .eq('tenant_id', tenantId)
        .order('id', { ascending: false })
        .limit(LIST_LIMIT),
      supabase
        .from('event')
        .select('id, title, start_date, location, is_online')
        .eq('tenant_id', tenantId)
        .order('start_date', { ascending: false })
        .limit(LIST_LIMIT),
      // Tenant-wide most recent booking (preserves original top-level field
      // semantics that were independent of the events list).
      supabase
        .from('booking')
        .select(
          'id, booking_reference, attendee_first_name, attendee_last_name, attendee_email, ticket_class_name, event_id, event!inner(tenant_id)',
        )
        .eq('event.tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('contract_instance')
        .select('id, sent_at, signers, form_id, form!inner(name, tenant_id)')
        .eq('form.tenant_id', tenantId)
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(LIST_LIMIT),
      // Optional tables — wrapped to never break the response.
      fetchOptional(
        supabase
          .from('dd_meeting_request')
          .select(
            'id, recipient_email, recipient_first_name, recipient_last_name, booked_at, status, meeting_template:meeting_template_id(id, name, duration_minutes)',
          )
          .eq('tenant_id', tenantId)
          .eq('status', 'booked')
          .order('booked_at', { ascending: false, nullsFirst: false })
          .limit(LIST_LIMIT),
        'dd_meeting_request',
      ),
      fetchOptional(
        supabase
          .from('form_submission_due_diligence')
          .select(
            'id, form_submission_id, application_uid, workflow_status, due_diligence_score, risk_level, reviewed_by, reviewed_date, form_submission:form_submission_id(form:form_id(name))',
          )
          .eq('tenant_id', tenantId)
          .order('updated_at', { ascending: false, nullsFirst: false })
          .limit(LIST_LIMIT),
        'form_submission_due_diligence',
      ),
    ]);

    if (tenantRes?.data) {
      result.tenant = { name: tenantRes.data.name };
    }

    const memberRows = membersRes?.data || [];
    if (memberRows.length > 0) {
      result.members = memberRows.map(buildMember).filter(Boolean);
      const m = result.members[0];
      result.member = m;
      result.attendee = {
        first_name: m.first_name,
        last_name: m.last_name,
        email: m.email,
      };
      result.sources.member = m.full_name;
    }

    const orgRows = orgsRes?.data || [];
    if (orgRows.length > 0) {
      result.organizations = orgRows.map(buildOrg).filter(Boolean);
      result.organization = result.organizations[0];
      result.sources.organization = result.organization.name;
    }

    const eventRows = eventsRes?.data || [];
    let bookingByEvent = {};
    if (eventRows.length > 0) {
      const eventIds = eventRows.map((e) => e.id).filter(Boolean);
      if (eventIds.length > 0) {
        const { data: bookings } = await supabase
          .from('booking')
          .select(
            'id, booking_reference, attendee_first_name, attendee_last_name, attendee_email, ticket_class_name, event_id, created_at',
          )
          .in('event_id', eventIds)
          .order('created_at', { ascending: false });
        for (const b of bookings || []) {
          if (!bookingByEvent[b.event_id]) bookingByEvent[b.event_id] = b;
        }
      }
      result.events = eventRows.map((e) => {
        const ev = buildEvent(e);
        const b = bookingByEvent[e.id] || null;
        const booking = buildBooking(b);
        const attendee = buildAttendee(b);
        return { ...ev, booking, attendee };
      });
      const firstEvent = result.events[0];
      result.event = {
        id: firstEvent.id,
        title: firstEvent.title,
        name: firstEvent.name,
        date: firstEvent.date,
        location: firstEvent.location,
      };
      result.sources.event = firstEvent.title;
    }

    if (latestBookingRes?.data) {
      const lb = latestBookingRes.data;
      result.booking = buildBooking(lb);
      const att = buildAttendee(lb);
      if (att) result.attendee = att;
      result.sources.booking = lb.booking_reference || lb.id;
    }

    const contractRows = contractsRes?.data || [];
    if (contractRows.length > 0) {
      result.contracts = contractRows.map(buildContract).filter(Boolean);
      const c = result.contracts[0];
      result.contract = c;
      result.sources.contract = c.name || c.signer?.full_name || c.id;
    }

    if (meetingsRows.length > 0) {
      result.meetings = meetingsRows.map(buildMeeting).filter(Boolean);
      result.meeting = result.meetings[0];
      result.sources.meeting = result.meeting.title;
    }

    if (ddRows.length > 0) {
      result.due_diligence_submissions = ddRows.map(buildDdSubmission).filter(Boolean);
      result.due_diligence = result.due_diligence_submissions[0];
      result.sources.due_diligence =
        result.due_diligence.form_name || result.due_diligence.id;
    }

    const hasAnyData =
      Object.keys(result.sources).length > 0 ||
      result.members.length > 0 ||
      result.organizations.length > 0 ||
      result.events.length > 0 ||
      result.contracts.length > 0 ||
      result.meetings.length > 0 ||
      result.due_diligence_submissions.length > 0;

    if (!hasAnyData) {
      return res.status(200).json({ source: 'fixture', tenantId });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[email-placeholder-samples] error:', err);
    return res.status(200).json({ source: 'fixture', tenantId });
  }
}
