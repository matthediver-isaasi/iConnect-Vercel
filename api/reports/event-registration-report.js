import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;
    const { eventId } = req.query;

    const { data: events, error: eventsError } = await supabase
      .from('event')
      .select('id, title, start_date, status')
      .eq('tenant_id', tenantId)
      .order('start_date', { ascending: false });

    if (eventsError) {
      console.error('[Event Registration Report] Error fetching events:', eventsError);
      return res.status(500).json({ error: 'Failed to fetch events' });
    }

    let bookingGroups = [];
    let organizations = {};
    let summary = {
      totalRevenue: 0,
      totalVoucher: 0,
      totalTrainingFund: 0,
      totalDiscount: 0,
      totalAccountPayments: 0,
      totalStripePayments: 0,
      countByMethod: {},
      countByStatus: {},
      totalBookings: 0,
      totalGroups: 0,
    };

    if (eventId) {
      const { data: bookingData, error: bookingsError } = await supabase
        .from('booking')
        .select('id, event_id, member_id, attendee_email, attendee_first_name, attendee_last_name, ticket_price, total_cost, payment_method, voucher_amount, training_fund_amount, account_amount, purchase_order_number, po_to_follow, stripe_payment_intent_id, ticket_class_name, organization_id, booking_reference, booking_group_reference, xero_invoice_id, xero_invoice_number, is_guest_booking, status, created_at')
        .eq('event_id', eventId)
        .eq('tenant_id', tenantId)
        .order('booking_group_reference', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false });

      if (bookingsError) {
        console.error('[Event Registration Report] Error fetching bookings:', bookingsError);
        return res.status(500).json({ error: 'Failed to fetch bookings' });
      }

      const bookings = bookingData || [];

      const orgIds = [...new Set(bookings.map(b => b.organization_id).filter(Boolean))];
      if (orgIds.length > 0) {
        const { data: orgs, error: orgsError } = await supabase
          .from('organization')
          .select('id, name')
          .in('id', orgIds);

        if (!orgsError && orgs) {
          for (const org of orgs) {
            organizations[org.id] = org.name;
          }
        }
      }

      const groupMap = new Map();
      for (const b of bookings) {
        const groupKey = b.booking_group_reference || `single_${b.id}`;
        if (!groupMap.has(groupKey)) {
          groupMap.set(groupKey, []);
        }
        groupMap.get(groupKey).push(b);
      }

      let totalRevenue = 0;
      let totalVoucher = 0;
      let totalTrainingFund = 0;
      let totalDiscount = 0;
      let totalAccountPayments = 0;
      let totalStripePayments = 0;
      const countByMethod = {};
      const countByStatus = {};

      for (const [groupRef, members] of groupMap) {
        const first = members[0];
        const isGroup = members.length > 1;

        const groupTicketTotal = members.reduce((sum, b) => sum + (Number(b.ticket_price) || 0), 0);
        const groupTotalCost = members.reduce((sum, b) => sum + (Number(b.total_cost) || 0), 0);

        const groupVoucher = Number(first.voucher_amount) || 0;
        const groupTrainingFund = Number(first.training_fund_amount) || 0;
        const groupAccountAmount = Number(first.account_amount) || 0;
        const groupDiscount = Math.max(0, groupTicketTotal - groupTotalCost);

        totalRevenue += groupTotalCost;
        totalVoucher += groupVoucher;
        totalTrainingFund += groupTrainingFund;
        totalDiscount += groupDiscount;
        totalAccountPayments += groupAccountAmount;

        if (first.payment_method === 'card' || first.stripe_payment_intent_id) {
          totalStripePayments += groupTotalCost;
        }

        const method = first.payment_method || 'unknown';
        countByMethod[method] = (countByMethod[method] || 0) + 1;

        for (const b of members) {
          const status = b.status || 'unknown';
          countByStatus[status] = (countByStatus[status] || 0) + 1;
        }

        bookingGroups.push({
          groupRef: groupRef.startsWith('single_') ? null : groupRef,
          isGroup,
          attendeeCount: members.length,
          groupPayment: {
            ticketTotal: groupTicketTotal,
            totalCost: groupTotalCost,
            discount: groupDiscount,
            voucherAmount: groupVoucher,
            trainingFundAmount: groupTrainingFund,
            accountAmount: groupAccountAmount,
            paymentMethod: first.payment_method,
            purchaseOrderNumber: first.purchase_order_number,
            poToFollow: first.po_to_follow,
            stripePaymentIntentId: first.stripe_payment_intent_id,
            xeroInvoiceNumber: first.xero_invoice_number,
            xeroInvoiceId: first.xero_invoice_id,
            bookingReference: first.booking_reference,
          },
          attendees: members.map(b => ({
            id: b.id,
            attendee_first_name: b.attendee_first_name,
            attendee_last_name: b.attendee_last_name,
            attendee_email: b.attendee_email,
            ticket_class_name: b.ticket_class_name,
            ticket_price: b.ticket_price,
            total_cost: b.total_cost,
            organization_id: b.organization_id,
            is_guest_booking: b.is_guest_booking,
            member_id: b.member_id,
            status: b.status,
            created_at: b.created_at,
          })),
        });
      }

      summary = {
        totalRevenue,
        totalVoucher,
        totalTrainingFund,
        totalDiscount,
        totalAccountPayments,
        totalStripePayments,
        countByMethod,
        countByStatus,
        totalBookings: bookings.length,
        totalGroups: groupMap.size,
      };
    }

    return res.status(200).json({
      events: events || [],
      bookingGroups,
      organizations,
      summary,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Event Registration Report] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch report data' });
  }
}
