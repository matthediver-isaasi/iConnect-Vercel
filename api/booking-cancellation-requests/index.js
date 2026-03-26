import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  if (req.method === 'POST') {
    return handlePost(req, res);
  }

  if (req.method === 'GET') {
    return handleGet(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function handlePost(req, res) {
  let member = await getSessionMember(req);
  let isAdmin = false;
  let tenantId = null;

  const ctx = await getTenantContext(req);
  if (ctx?.isAuthenticated) {
    isAdmin = await hasAdminAccess(ctx);
  }

  if (member) {
    tenantId = member.organization?.tenant_id || member.tenant_id;
  } else if (isAdmin) {
    tenantId = ctx.tenantId;
  }

  if (!tenantId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { booking_ids, booking_group_reference, request_type, reason } = req.body;

  if (!booking_ids || !Array.isArray(booking_ids) || booking_ids.length === 0) {
    return res.status(400).json({ error: 'booking_ids is required and must be a non-empty array' });
  }

  if (!request_type || !['individual', 'group'].includes(request_type)) {
    return res.status(400).json({ error: 'request_type must be "individual" or "group"' });
  }

  try {
    const { data: bookings, error: bookingsError } = await supabase
      .from('booking')
      .select('id, event_id, member_id, status, booking_group_reference, attendee_email')
      .in('id', booking_ids)
      .eq('tenant_id', tenantId);

    if (bookingsError) {
      console.error('[CancellationRequest] Error fetching bookings:', bookingsError);
      return res.status(500).json({ error: 'Failed to validate bookings' });
    }

    if (!bookings || bookings.length === 0) {
      return res.status(404).json({ error: 'No matching bookings found' });
    }

    if (bookings.length !== booking_ids.length) {
      return res.status(400).json({ error: 'Some booking IDs are invalid or do not belong to your tenant' });
    }

    if (!isAdmin) {
      const memberEmail = member.email?.toLowerCase();
      const unauthorizedBookings = bookings.filter(b =>
        b.member_id !== member.id && (b.attendee_email || '').toLowerCase() !== memberEmail
      );
      if (unauthorizedBookings.length > 0) {
        return res.status(403).json({ error: 'You can only request cancellation for your own bookings' });
      }
    }

    const alreadyCancelled = bookings.filter(b => b.status === 'cancelled');
    if (alreadyCancelled.length > 0) {
      return res.status(400).json({ error: 'Some bookings are already cancelled' });
    }

    const { data: existingRequests } = await supabase
      .from('booking_cancellation_request')
      .select('booking_id')
      .in('booking_id', booking_ids)
      .eq('status', 'pending')
      .eq('tenant_id', tenantId);

    const alreadyRequested = existingRequests?.map(r => r.booking_id) || [];
    const newBookingIds = booking_ids.filter(id => !alreadyRequested.includes(id));

    if (newBookingIds.length === 0) {
      return res.status(400).json({ error: 'Cancellation requests already exist for all selected bookings' });
    }

    const rows = newBookingIds.map(bookingId => {
      const booking = bookings.find(b => b.id === bookingId);
      return {
        tenant_id: tenantId,
        booking_id: bookingId,
        booking_group_reference: booking_group_reference || booking?.booking_group_reference || null,
        event_id: booking?.event_id || null,
        member_id: isAdmin ? (booking?.member_id || null) : member.id,
        request_type,
        reason: reason || null,
        status: 'pending',
      };
    });

    const { data: created, error: insertError } = await supabase
      .from('booking_cancellation_request')
      .insert(rows)
      .select();

    if (insertError) {
      console.error('[CancellationRequest] Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to create cancellation request' });
    }

    console.log(`[CancellationRequest] Created ${created.length} request(s)${isAdmin ? ' (admin-initiated)' : ` for member ${member.id}`}`);
    return res.status(201).json({ requests: created, skipped: alreadyRequested.length });
  } catch (err) {
    console.error('[CancellationRequest] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(req, res) {
  const ctx = await getTenantContext(req);
  if (!ctx.isAuthenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const tenantId = ctx.tenantId;
  let memberIdFilter = null;
  let memberEmailFilter = null;

  const isAdmin = await hasAdminAccess(ctx);
  if (!isAdmin) {
    memberIdFilter = ctx.memberId;
    if (ctx.memberId) {
      const { data: memberData } = await supabase
        .from('member')
        .select('email')
        .eq('id', ctx.memberId)
        .single();
      memberEmailFilter = memberData?.email?.toLowerCase() || null;
    }
  }

  if (!tenantId) {
    return res.status(400).json({ error: 'Could not determine tenant' });
  }

  const { status: statusFilter } = req.query;

  try {
    let requests;

    if (memberIdFilter) {
      const bookingIdsForAttendee = [];
      if (memberEmailFilter) {
        const { data: attendeeBookings } = await supabase
          .from('booking')
          .select('id')
          .eq('tenant_id', tenantId)
          .ilike('attendee_email', memberEmailFilter);

        if (attendeeBookings?.length > 0) {
          bookingIdsForAttendee.push(...attendeeBookings.map(b => b.id));
        }
      }

      let query = supabase
        .from('booking_cancellation_request')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });

      if (bookingIdsForAttendee.length > 0) {
        query = query.or(`member_id.eq.${memberIdFilter},booking_id.in.(${bookingIdsForAttendee.join(',')})`);
      } else {
        query = query.eq('member_id', memberIdFilter);
      }

      if (statusFilter && ['pending', 'approved', 'rejected'].includes(statusFilter)) {
        query = query.eq('status', statusFilter);
      }

      const { data, error } = await query;
      if (error) {
        console.error('[CancellationRequest] Error fetching requests:', error);
        return res.status(500).json({ error: 'Failed to fetch requests' });
      }
      requests = data;
    } else {
      let query = supabase
        .from('booking_cancellation_request')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });

      if (statusFilter && ['pending', 'approved', 'rejected'].includes(statusFilter)) {
        query = query.eq('status', statusFilter);
      }

      const { data, error } = await query;
      if (error) {
        console.error('[CancellationRequest] Error fetching requests:', error);
        return res.status(500).json({ error: 'Failed to fetch requests' });
      }
      requests = data;
    }

    const bookingIds = [...new Set((requests || []).map(r => r.booking_id))];
    const memberIds = [...new Set((requests || []).map(r => r.member_id))];

    let bookingsMap = {};
    if (bookingIds.length > 0) {
      const { data: bookings } = await supabase
        .from('booking')
        .select('id, attendee_email, attendee_first_name, attendee_last_name, event_id, status, booking_group_reference, booking_reference, ticket_class_name, training_fund_amount, voucher_amount, discount_code_id, discount_code_amount, stripe_payment_intent_id, account_amount, total_cost, payment_method, organization_id, xero_invoice_id, xero_invoice_number')
        .in('id', bookingIds);
      bookingsMap = (bookings || []).reduce((acc, b) => { acc[b.id] = b; return acc; }, {});
    }

    const orgIds = [...new Set(Object.values(bookingsMap).map(b => b.organization_id).filter(Boolean))];
    let orgsMap = {};
    if (orgIds.length > 0) {
      const { data: orgs } = await supabase
        .from('organization')
        .select('id, invoicing_email')
        .in('id', orgIds);
      orgsMap = (orgs || []).reduce((acc, o) => { acc[o.id] = o; return acc; }, {});
    }

    const eventIds = [...new Set([
      ...(requests || []).filter(r => r.event_id).map(r => r.event_id),
      ...Object.values(bookingsMap).filter(b => b.event_id).map(b => b.event_id),
    ])];

    let membersMap = {};
    if (memberIds.length > 0) {
      const { data: members } = await supabase
        .from('member')
        .select('id, first_name, last_name, email')
        .in('id', memberIds);
      membersMap = (members || []).reduce((acc, m) => { acc[m.id] = m; return acc; }, {});
    }

    let eventsMap = {};
    if (eventIds.length > 0) {
      const { data: events } = await supabase
        .from('event')
        .select('id, title, start_date, location, program_tag')
        .in('id', eventIds);
      eventsMap = (events || []).reduce((acc, e) => { acc[e.id] = e; return acc; }, {});
    }

    // Fetch voucher expiry data for reversal preview
    const bookingRefs = [...new Set(Object.values(bookingsMap).map(b => b.booking_group_reference || b.booking_reference).filter(Boolean))];
    let voucherTxnsByRef = {};
    if (bookingRefs.length > 0) {
      const { data: voucherTxns } = await supabase
        .from('voucher_transaction')
        .select('id, voucher_id, booking_reference, amount, type')
        .in('booking_reference', bookingRefs)
        .eq('type', 'booking_usage');
      if (voucherTxns && voucherTxns.length > 0) {
        const voucherIds = [...new Set(voucherTxns.map(vt => vt.voucher_id))];
        const { data: vouchers } = await supabase
          .from('voucher')
          .select('id, code, value, expires_at, status')
          .in('id', voucherIds);
        const vouchersMap = (vouchers || []).reduce((acc, v) => { acc[v.id] = v; return acc; }, {});
        for (const vt of voucherTxns) {
          if (!voucherTxnsByRef[vt.booking_reference]) voucherTxnsByRef[vt.booking_reference] = [];
          const voucher = vouchersMap[vt.voucher_id];
          voucherTxnsByRef[vt.booking_reference].push({
            voucherId: vt.voucher_id,
            amount: vt.amount,
            code: voucher?.code || null,
            expired: voucher?.expires_at ? new Date(voucher.expires_at) < new Date() : false,
            expiresAt: voucher?.expires_at || null,
          });
        }
      }
    }

    // Fetch discount code expiry data for reversal preview
    const discountCodeIds = [...new Set(Object.values(bookingsMap).map(b => b.discount_code_id).filter(Boolean))];
    let discountCodesMap = {};
    if (discountCodeIds.length > 0) {
      const { data: discountCodes } = await supabase
        .from('discount_code')
        .select('id, code, type, value, expires_at, is_active')
        .in('id', discountCodeIds);
      discountCodesMap = (discountCodes || []).reduce((acc, dc) => { acc[dc.id] = dc; return acc; }, {});
    }

    const enrichedRequests = (requests || []).map(r => {
      const booking = bookingsMap[r.booking_id] || null;
      const eventId = r.event_id || booking?.event_id || null;

      let financialSummary = null;
      if (booking && r.status === 'pending') {
        const bookingRef = booking.booking_group_reference || booking.booking_reference;
        const voucherDetails = voucherTxnsByRef[bookingRef] || [];
        const discountCode = booking.discount_code_id ? discountCodesMap[booking.discount_code_id] || null : null;

        const totalCost = parseFloat(booking.total_cost) || 0;
        const trainingFundAmount = parseFloat(booking.training_fund_amount) || 0;
        const voucherAmount = parseFloat(booking.voucher_amount) || 0;
        const discountCodeAmount = parseFloat(booking.discount_code_amount) || 0;
        const accountAmount = parseFloat(booking.account_amount) || 0;
        const cardAmount = Math.max(0, totalCost - trainingFundAmount - voucherAmount - discountCodeAmount - accountAmount);

        financialSummary = {
          trainingFundAmount,
          voucherAmount,
          voucherDetails,
          discountCodeAmount,
          discountCode: discountCode ? {
            id: discountCode.id,
            code: discountCode.code,
            type: discountCode.type,
            value: discountCode.value,
            expired: discountCode.expires_at ? new Date(discountCode.expires_at) < new Date() : false,
            expiresAt: discountCode.expires_at,
          } : null,
          stripePaymentIntentId: booking.stripe_payment_intent_id || null,
          cardAmount,
          accountAmount,
          totalCost,
          paymentMethod: booking.payment_method,
          xeroInvoiceId: booking.xero_invoice_id || null,
          xeroInvoiceNumber: booking.xero_invoice_number || null,
          invoicingEmail: booking.organization_id ? (orgsMap[booking.organization_id]?.invoicing_email || null) : null,
        };
      }

      return {
        ...r,
        booking,
        member: membersMap[r.member_id] || null,
        event: eventId ? (eventsMap[eventId] || null) : null,
        financialSummary,
      };
    });

    const groupFinancialSummaries = {};
    const pendingGroupRequests = enrichedRequests.filter(r => r.status === 'pending' && r.booking_group_reference);
    const groupsByRef = {};
    for (const r of pendingGroupRequests) {
      if (!groupsByRef[r.booking_group_reference]) groupsByRef[r.booking_group_reference] = [];
      groupsByRef[r.booking_group_reference].push(r);
    }

    for (const [ref, groupItems] of Object.entries(groupsByRef)) {
      if (groupItems.length < 2) continue;
      let totalTrainingFund = 0;
      let totalVoucher = 0;
      let totalDiscount = 0;
      let totalCard = 0;
      let totalAccount = 0;
      let totalCost = 0;
      let stripePaymentIntentId = null;
      let xeroInvoiceId = null;
      let xeroInvoiceNumber = null;
      let invoicingEmail = null;
      let paymentMethod = null;
      const allVoucherDetails = [];
      let discountCode = null;
      const seenVoucherIds = new Set();
      const seenStripeIntents = new Set();
      const seenXeroInvoices = new Set();

      for (const item of groupItems) {
        const fs = item.financialSummary;
        if (!fs) continue;
        totalTrainingFund += fs.trainingFundAmount || 0;
        totalVoucher += fs.voucherAmount || 0;
        totalDiscount += fs.discountCodeAmount || 0;
        totalCard += fs.cardAmount || 0;
        totalAccount += fs.accountAmount || 0;
        totalCost += fs.totalCost || 0;
        if (fs.stripePaymentIntentId) {
          seenStripeIntents.add(fs.stripePaymentIntentId);
          if (!stripePaymentIntentId) stripePaymentIntentId = fs.stripePaymentIntentId;
        }
        if (fs.xeroInvoiceId) {
          seenXeroInvoices.add(fs.xeroInvoiceId);
          if (!xeroInvoiceId) {
            xeroInvoiceId = fs.xeroInvoiceId;
            xeroInvoiceNumber = fs.xeroInvoiceNumber;
          }
        }
        if (!invoicingEmail && fs.invoicingEmail) invoicingEmail = fs.invoicingEmail;
        if (!paymentMethod && fs.paymentMethod) paymentMethod = fs.paymentMethod;
        if (fs.voucherDetails) {
          for (const vd of fs.voucherDetails) {
            if (!seenVoucherIds.has(vd.voucherId)) {
              seenVoucherIds.add(vd.voucherId);
              allVoucherDetails.push(vd);
            }
          }
        }
        if (!discountCode && fs.discountCode) discountCode = fs.discountCode;
      }

      const hasMultipleStripeIntents = seenStripeIntents.size > 1;
      const hasMultipleXeroInvoices = seenXeroInvoices.size > 1;

      groupFinancialSummaries[ref] = {
        trainingFundAmount: totalTrainingFund,
        voucherAmount: totalVoucher,
        voucherDetails: allVoucherDetails,
        discountCodeAmount: totalDiscount,
        discountCode,
        stripePaymentIntentId,
        cardAmount: totalCard,
        accountAmount: totalAccount,
        totalCost,
        paymentMethod,
        xeroInvoiceId,
        xeroInvoiceNumber,
        invoicingEmail,
        ticketCount: groupItems.length,
        consolidated: true,
        hasMultipleStripeIntents,
        hasMultipleXeroInvoices,
      };
    }

    for (const r of enrichedRequests) {
      if (r.booking_group_reference && groupFinancialSummaries[r.booking_group_reference]) {
        r.groupFinancialSummary = groupFinancialSummaries[r.booking_group_reference];
      }
    }

    return res.json({ requests: enrichedRequests });
  } catch (err) {
    console.error('[CancellationRequest] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
