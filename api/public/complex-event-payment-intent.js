import Stripe from 'stripe';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getStripeCredentials } from '../_lib/stripeCredentials.js';
import { createClient } from '@supabase/supabase-js';
import { getSessionMember } from '../_lib/session.js';
import {
  resolveTicketPrice,
  getTicketClassFromConfig,
  isTicketVisibleToUser,
  validateDiscountCode,
  computeDiscountedPrice
} from '../_lib/complexEventPricing.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) return res.status(503).json({ error: 'Supabase not configured' });

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const { event_id, ticket_class_id, attendee_count = 1, discount_code, items } = req.body;

    if (!event_id) {
      return res.status(400).json({ error: 'event_id is required' });
    }

    const isMultiTicket = Array.isArray(items) && items.length > 0;

    if (!isMultiTicket && !ticket_class_id) {
      return res.status(400).json({ error: 'ticket_class_id or items array is required' });
    }

    const { data: event, error: eventError } = await supabase
      .from('complex_event')
      .select('id, title, tenant_id, status')
      .eq('id', event_id)
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc'])
      .single();

    if (eventError || !event) return res.status(404).json({ error: 'Event not found' });

    const { data: ticketClassRows } = await supabase
      .from('complex_event_ticket_class')
      .select('*')
      .eq('complex_event_id', event_id)
      .eq('tenant_id', tenant.id);

    const allTicketClasses = ticketClassRows || [];

    let member = null;
    let memberTenantId = null;
    try {
      member = await getSessionMember(req);
      if (member) {
        const { data: memberData } = await supabase
          .from('member')
          .select('id, tenant_id, email, organization_id, role_id')
          .eq('id', member.id)
          .single();
        if (memberData) {
          memberTenantId = memberData.tenant_id;
          member = { ...member, ...memberData };
        }
      }
    } catch (e) {}

    const isMember = member && memberTenantId === tenant.id;

    const normalizedItems = isMultiTicket
      ? items.map(item => ({
          ticket_class_id: item.ticket_class_id,
          attendee_count: Math.max(1, Math.min(100, parseInt(item.attendee_count) || 1)),
          discount_code: item.discount_code || null
        }))
      : [{
          ticket_class_id,
          attendee_count: Math.max(1, Math.min(100, parseInt(attendee_count) || 1)),
          discount_code: discount_code || null
        }];

    let grandTotalMinor = 0;
    let currency = 'gbp';
    const ticketClassIds = [];
    const itemDetails = [];

    for (const item of normalizedItems) {
      const ticketClass = getTicketClassFromConfig(allTicketClasses, item.ticket_class_id);
      if (!ticketClass) {
        return res.status(400).json({ error: `Invalid ticket class: ${item.ticket_class_id}` });
      }

      if (!isTicketVisibleToUser(ticketClass, isMember)) {
        return res.status(403).json({ error: `Ticket class ${ticketClass.name || item.ticket_class_id} is not available to you` });
      }

      const ticket = resolveTicketPrice(allTicketClasses, item.ticket_class_id);
      if (!ticket.found) {
        return res.status(400).json({ error: `Invalid ticket class: ${item.ticket_class_id}` });
      }

      let finalPrice = ticket.price;

      if (ticket.price === 0) {
        ticketClassIds.push(item.ticket_class_id);
        itemDetails.push({
          ticket_class_id: item.ticket_class_id,
          ticket_name: ticket.name,
          unit_price: 0,
          original_price: 0,
          attendee_count: item.attendee_count,
          discount_code: null
        });
        continue;
      }

      if (item.discount_code) {
        const discountResult = await validateDiscountCode({
          code: item.discount_code,
          tenantId: tenant.id,
          eventId: event_id,
          memberId: isMember ? member.id : null,
          memberRoleId: isMember ? member.role_id : null,
          orgId: isMember ? member.organization_id : null
        });

        if (discountResult.valid) {
          finalPrice = computeDiscountedPrice(ticket.price, discountResult.discountCode);
        } else {
          return res.status(400).json({ error: discountResult.reason });
        }
      }

      if (finalPrice <= 0) {
        ticketClassIds.push(item.ticket_class_id);
        itemDetails.push({
          ticket_class_id: item.ticket_class_id,
          ticket_name: ticket.name,
          unit_price: 0,
          original_price: ticket.price,
          attendee_count: item.attendee_count,
          discount_code: item.discount_code || null
        });
        continue;
      }

      const itemTotal = Math.round(finalPrice * item.attendee_count * 100);
      grandTotalMinor += itemTotal;
      const itemCurrency = (ticket.currency || 'gbp').toLowerCase();
      if (ticketClassIds.length > 0 && itemCurrency !== currency) {
        return res.status(400).json({ error: 'All ticket classes must use the same currency' });
      }
      currency = itemCurrency;
      ticketClassIds.push(item.ticket_class_id);
      itemDetails.push({
        ticket_class_id: item.ticket_class_id,
        ticket_name: ticket.name,
        unit_price: finalPrice,
        original_price: ticket.price,
        attendee_count: item.attendee_count,
        subtotal_minor: itemTotal
      });
    }

    if (grandTotalMinor <= 0) {
      return res.status(400).json({ error: 'Total is zero — use free registration instead', free_registration: true });
    }

    const creds = await getStripeCredentials(tenant.id, 'events');
    if (!creds?.secret_key || !creds.is_enabled) {
      return res.status(503).json({ error: 'Stripe not configured for this tenant' });
    }

    const stripe = new Stripe(creds.secret_key);

    const metadata = {
      event_id,
      ticket_class_ids: ticketClassIds.join(','),
      tenant_id: tenant.id,
      type: 'complex_event_booking',
      is_multi_ticket: isMultiTicket ? 'true' : 'false'
    };

    if (!isMultiTicket) {
      metadata.ticket_class_id = ticket_class_id;
      metadata.attendee_count = String(normalizedItems[0].attendee_count);
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: grandTotalMinor,
      currency,
      metadata,
      ...(isMember && member.email ? { receipt_email: member.email } : {})
    });

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: creds.publishable_key,
      amount: grandTotalMinor,
      currency,
      items: itemDetails
    });
  } catch (error) {
    console.error('[Complex Event Payment Intent] Error:', error);
    return res.status(500).json({ error: 'Failed to create payment intent' });
  }
}
