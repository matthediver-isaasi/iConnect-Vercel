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

    let bookings = [];
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
    };

    if (eventId) {
      const { data: bookingData, error: bookingsError } = await supabase
        .from('booking')
        .select('id, event_id, member_id, attendee_email, attendee_first_name, attendee_last_name, ticket_price, total_cost, payment_method, voucher_amount, training_fund_amount, account_amount, purchase_order_number, po_to_follow, stripe_payment_intent_id, ticket_class_name, organization_id, booking_reference, booking_group_reference, xero_invoice_id, xero_invoice_number, is_guest_booking, status, created_at')
        .eq('event_id', eventId)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });

      if (bookingsError) {
        console.error('[Event Registration Report] Error fetching bookings:', bookingsError);
        return res.status(500).json({ error: 'Failed to fetch bookings' });
      }

      bookings = bookingData || [];

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

      let totalRevenue = 0;
      let totalVoucher = 0;
      let totalTrainingFund = 0;
      let totalDiscount = 0;
      let totalAccountPayments = 0;
      let totalStripePayments = 0;
      const countByMethod = {};
      const countByStatus = {};

      for (const b of bookings) {
        totalRevenue += Number(b.total_cost) || 0;
        totalVoucher += Number(b.voucher_amount) || 0;
        totalTrainingFund += Number(b.training_fund_amount) || 0;
        totalDiscount += Math.max(0, (Number(b.ticket_price) || 0) - (Number(b.total_cost) || 0));
        totalAccountPayments += Number(b.account_amount) || 0;

        if (b.payment_method === 'card' || b.stripe_payment_intent_id) {
          totalStripePayments += Number(b.total_cost) || 0;
        }

        const method = b.payment_method || 'unknown';
        countByMethod[method] = (countByMethod[method] || 0) + 1;

        const status = b.status || 'unknown';
        countByStatus[status] = (countByStatus[status] || 0) + 1;
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
      };
    }

    return res.status(200).json({
      events: events || [],
      bookings,
      organizations,
      summary,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Event Registration Report] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch report data' });
  }
}
