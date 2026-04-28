/**
 * GET /api/admin/email-placeholder-samples
 *
 * Returns sample data used by the Email Placeholders reference page to render
 * a live preview of how each placeholder resolves.
 *
 * Returns both:
 *   - Top-level "most recent of each" fields (member, organization, event,
 *     booking, contract) for backward compatibility / default view.
 *   - Lists per kind (members[], organizations[], events[] with their most
 *     recent booking attached, contracts[]) — capped at ~25 most-recent rows
 *     so the page can offer a per-section record picker.
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
  };

  try {
    const [tenantRes, membersRes, orgsRes, eventsRes, contractsRes] = await Promise.all([
      supabase
        .from('tenant')
        .select('id, name')
        .eq('id', tenantId)
        .maybeSingle(),
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
      supabase
        .from('contract_instance')
        .select('id, sent_at, signers, form_id, form!inner(name, tenant_id)')
        .eq('form.tenant_id', tenantId)
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(LIST_LIMIT),
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
      if (firstEvent.booking) {
        result.booking = firstEvent.booking;
        result.sources.booking = firstEvent.booking.reference || firstEvent.booking.id;
      }
      if (firstEvent.attendee) {
        result.attendee = firstEvent.attendee;
      }
    }

    const contractRows = contractsRes?.data || [];
    if (contractRows.length > 0) {
      result.contracts = contractRows.map(buildContract).filter(Boolean);
      const c = result.contracts[0];
      result.contract = c;
      result.sources.contract = c.name || c.signer?.full_name || c.id;
    }

    if (
      Object.keys(result.sources).length === 0 &&
      result.members.length === 0 &&
      result.organizations.length === 0 &&
      result.events.length === 0 &&
      result.contracts.length === 0
    ) {
      return res.status(200).json({ source: 'fixture', tenantId });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[email-placeholder-samples] error:', err);
    return res.status(200).json({ source: 'fixture', tenantId });
  }
}
