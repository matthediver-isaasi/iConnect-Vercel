import { getSessionMember } from '../_lib/session.js';
import { getAccountingProvider, getAccountingProviderByName } from '../_lib/accountingProvider.js';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const sessionMember = await getSessionMember(req);
  const context = await getTenantContext(req);
  if (context?.tenantMismatch || (sessionMember?.tenant_id && context?.tenantId && sessionMember.tenant_id !== context.tenantId)) {
    return res.status(403).json({ error: 'Tenant context mismatch' });
  }
  const isAdmin = context?.isAuthenticated && await hasAdminAccess(context);
  const tenantId = sessionMember?.tenant_id || (isAdmin && context?.tenantId);
  if (!tenantId || (!sessionMember && !isAdmin)) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { bookingGroupRef, bookingId, source } = req.query;
  const scoped = bookingId !== undefined || source !== undefined;
  if (scoped && (typeof bookingId !== 'string' || !/^[0-9a-f-]{36}$/i.test(bookingId)
    || !['booking', 'complex_event_booking'].includes(source))) {
    return res.status(400).json({ error: 'Valid booking identity and source required' });
  }

  if (!bookingGroupRef) {
    return res.status(400).json({ error: 'Booking group reference required' });
  }

  try {
    let booking = null;
    let bookingSource = scoped ? source : 'booking';
    const fields = 'id, accounting_provider, xero_credit_note_id, xero_credit_note_number, accounting_credit_note_id, accounting_credit_note_number, member_id, organization_id';
    const lookup = table => {
      let query = supabase.from(table).select(fields)
        .eq('booking_group_reference', bookingGroupRef).eq('tenant_id', tenantId)
        .or('xero_credit_note_id.not.is.null,accounting_credit_note_id.not.is.null');
      if (scoped) query = query.eq('id', bookingId);
      return query.limit(1).maybeSingle();
    };

    const { data: regularBooking, error } = await lookup(bookingSource);

    if (error) {
      console.error('Error fetching booking for credit note:', error);
      return res.status(500).json({ error: 'Failed to fetch booking' });
    }

    booking = regularBooking;
    const hasCN = (b) => b && (b.accounting_credit_note_id || b.xero_credit_note_id);

    if (!hasCN(booking) && !scoped) {
      const { data: complexBooking, error: complexError } = await lookup('complex_event_booking');

      if (complexError) {
        console.error('Error fetching complex event booking for credit note:', complexError);
        return res.status(500).json({ error: 'Failed to fetch booking' });
      }

      if (hasCN(complexBooking)) {
        booking = complexBooking;
        bookingSource = 'complex_event_booking';
      }
    }

    if (!hasCN(booking)) {
      return res.status(404).json({ error: 'Credit note not found for this booking' });
    }

    const isSameMember = !!sessionMember && booking.member_id === sessionMember.id;
    const isSameOrg = sessionMember?.organization_id && booking.organization_id && sessionMember.organization_id === booking.organization_id;

    if (!isAdmin && !isSameMember && !isSameOrg) {
      return res.status(403).json({ error: 'Not authorized to view this credit note' });
    }

    const appTenantId = tenantId;
    if (!appTenantId) {
      console.error('[booking-credit-note] Cannot determine tenant for Xero PDF fetch');
      return res.status(500).json({ error: 'Cannot determine tenant context for credit note' });
    }

    const creditNoteId = booking.accounting_credit_note_id || booking.xero_credit_note_id;
    const creditNoteNumber = booking.accounting_credit_note_number || booking.xero_credit_note_number;
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.query.format === 'json') {
      const { data: evidence, error: evidenceError } = await supabase.from('booking_reversal_evidence')
        .select('amount_minor,currency').eq('tenant_id', tenantId).eq('booking_source', bookingSource)
        .contains('booking_ids', [booking.id]).eq('leg', 'credit_note').eq('status', 'confirmed')
        .eq('provider_id', creditNoteId).limit(100);
      if (evidenceError) throw evidenceError;
      // The amount describes the whole credit note, not an invented allocation
      // to this attendee. Never infer it from the original ticket price.
      const amounts = [...new Map((evidence || []).filter(e => e.amount_minor != null
        && Number.isSafeInteger(Number(e.amount_minor)) && /^[A-Z]{3}$/.test(e.currency))
        .map(e => [`${e.currency}:${e.amount_minor}`, { amount_minor: Number(e.amount_minor), currency: e.currency }])).values()];
      return res.json({ creditNoteId, creditNoteNumber,
        ...(evidence?.length < 100 && amounts.length === 1 ? amounts[0] : { amount_minor: null, currency: null }) });
    }
    const pinnedProvider = booking.accounting_provider || (booking.xero_credit_note_id ? 'xero' : null);
    const provider = pinnedProvider ? getAccountingProviderByName(pinnedProvider) : await getAccountingProvider(appTenantId);
    const pdfBuffer = await provider.fetchCreditNotePdf(creditNoteId, appTenantId);

    const inline = req.query.inline === 'true';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);

    const disposition = inline ? 'inline' : 'attachment';
    const filename = String(creditNoteNumber || bookingGroupRef).replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Disposition', `${disposition}; filename="credit-note-${filename}.pdf"`);

    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Error serving credit note PDF:', error);
    if (error.code === 'ACCOUNTING_PROVIDER_NONE' || error.code === 'ACCOUNTING_PROVIDER_NOT_CONFIGURED') {
      return res.status(503).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to fetch credit note from accounting provider' });
  }
}
