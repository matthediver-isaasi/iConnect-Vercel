/**
 * GET /api/admin/email-placeholder-samples
 *
 * Returns sample data used by the Email Placeholders reference page to render
 * a live preview of how each placeholder resolves. Pulls a recent member,
 * organisation, event/booking and contract for the current tenant where
 * available — the frontend falls back to a built-in fixture for any field that
 * is not present.
 *
 * Auth: requires an authenticated context with admin access (tenant user or
 * member whose role has admin permissions). Non-admin members are rejected
 * because the response includes tenant-wide PII (member email, booking
 * attendee info, contract signer details) intended for template authors.
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

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
    return res.status(200).json({ source: 'fixture' });
  }

  const result = { source: 'real', sources: {} };

  try {
    const [tenantRes, memberRes, orgRes, eventRes, bookingRes, contractRes] = await Promise.all([
      supabase
        .from('tenant')
        .select('id, name')
        .eq('id', tenantId)
        .maybeSingle(),
      supabase
        .from('member')
        .select('id, first_name, last_name, email, mobile, organization_id')
        .eq('tenant_id', tenantId)
        .not('email', 'like', 'deleted_%@deleted.local')
        .order('created_on', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('organization')
        .select('id, name, invoicing_email, phone')
        .eq('tenant_id', tenantId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('event')
        .select('id, title, start_date, location, is_online')
        .eq('tenant_id', tenantId)
        .order('start_date', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('booking')
        .select('id, booking_reference, attendee_first_name, attendee_last_name, attendee_email, ticket_class_name, event_id, event!inner(tenant_id)')
        .eq('event.tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('contract_instance')
        .select('id, sent_at, signers, form_id, form!inner(name, tenant_id)')
        .eq('form.tenant_id', tenantId)
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (tenantRes?.data) {
      result.tenant = { name: tenantRes.data.name };
    }

    if (memberRes?.data) {
      const m = memberRes.data;
      const fullName = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email;
      result.member = {
        id: m.id,
        first_name: m.first_name,
        last_name: m.last_name,
        full_name: fullName,
        email: m.email,
        phone: m.mobile,
      };
      result.attendee = {
        first_name: m.first_name,
        last_name: m.last_name,
        email: m.email,
      };
      result.sources.member = fullName;
    }

    if (orgRes?.data) {
      result.organization = {
        id: orgRes.data.id,
        name: orgRes.data.name,
        invoicing_email: orgRes.data.invoicing_email,
        phone: orgRes.data.phone,
      };
      result.sources.organization = orgRes.data.name;
    }

    if (eventRes?.data) {
      const e = eventRes.data;
      const dateStr = e.start_date
        ? new Date(e.start_date).toLocaleDateString('en-GB', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })
        : null;
      result.event = {
        id: e.id,
        title: e.title,
        name: e.title,
        date: dateStr,
        location: e.is_online ? 'Online Event' : e.location,
      };
      result.sources.event = e.title;
    }

    if (bookingRes?.data) {
      const b = bookingRes.data;
      result.booking = {
        id: b.id,
        reference: b.booking_reference,
        ticket_class: b.ticket_class_name || 'Standard',
      };
      if (b.attendee_first_name || b.attendee_last_name || b.attendee_email) {
        result.attendee = {
          first_name: b.attendee_first_name,
          last_name: b.attendee_last_name,
          email: b.attendee_email,
        };
      }
      result.sources.booking = b.booking_reference || b.id;
    }

    if (contractRes?.data) {
      const ci = contractRes.data;
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

      result.contract = {
        signer: {
          first_name: firstSigner.first_name || null,
          last_name: firstSigner.last_name || null,
          full_name: signerName,
          email: firstSigner.email || null,
        },
      };
      if (daysSinceSent !== null) {
        result.contract.days_since_sent = daysSinceSent;
      }

      const formName = ci.form?.name;
      if (formName) {
        result.contract.name = formName;
        result.sources.contract = formName;
      } else {
        result.sources.contract = signerName;
      }
    }

    if (Object.keys(result.sources).length === 0) {
      return res.status(200).json({ source: 'fixture' });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[email-placeholder-samples] error:', err);
    return res.status(200).json({ source: 'fixture' });
  }
}
