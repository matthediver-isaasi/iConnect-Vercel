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

    const { event_id, ticket_class_id, attendee_count = 1, discount_code } = req.body;

    if (!event_id || !ticket_class_id) {
      return res.status(400).json({ error: 'event_id and ticket_class_id are required' });
    }

    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('id, title, is_complex, tenant_id, pricing_config, status')
      .eq('id', event_id)
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc'])
      .single();

    if (eventError || !event) return res.status(404).json({ error: 'Event not found' });
    if (!event.is_complex) return res.status(400).json({ error: 'This endpoint is for complex events only' });

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

    const ticketClass = getTicketClassFromConfig(event.pricing_config, ticket_class_id);
    if (!ticketClass) {
      return res.status(400).json({ error: 'Invalid ticket class' });
    }

    if (!isTicketVisibleToUser(ticketClass, isMember)) {
      return res.status(403).json({ error: 'This ticket class is not available to you' });
    }

    const ticket = resolveTicketPrice(event.pricing_config, ticket_class_id);
    if (!ticket.found || ticket.price === 0) {
      return res.status(400).json({ error: 'Invalid or free ticket class' });
    }

    let finalPrice = ticket.price;
    let validatedDiscountCode = null;

    if (discount_code) {
      const discountResult = await validateDiscountCode({
        code: discount_code,
        tenantId: tenant.id,
        eventId: event_id,
        memberId: isMember ? member.id : null,
        memberRoleId: isMember ? member.role_id : null,
        orgId: isMember ? member.organization_id : null
      });

      if (discountResult.valid) {
        finalPrice = computeDiscountedPrice(ticket.price, discountResult.discountCode);
        validatedDiscountCode = discountResult.discountCode;
      } else {
        return res.status(400).json({ error: discountResult.reason });
      }
    }

    if (finalPrice <= 0) {
      return res.status(400).json({ error: 'Discounted price is zero. Use free registration instead.' });
    }

    const count = Math.max(1, Math.min(100, parseInt(attendee_count) || 1));
    const totalAmountMinor = Math.round(finalPrice * count * 100);
    const currency = ticket.currency || 'gbp';

    const creds = await getStripeCredentials(tenant.id, 'events');
    if (!creds?.secret_key || !creds.is_enabled) {
      return res.status(503).json({ error: 'Stripe not configured for this tenant' });
    }

    const stripe = new Stripe(creds.secret_key);

    const metadata = {
      event_id,
      ticket_class_id,
      tenant_id: tenant.id,
      attendee_count: String(count),
      type: 'complex_event_booking'
    };
    if (validatedDiscountCode) {
      metadata.discount_code_id = validatedDiscountCode.id;
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmountMinor,
      currency,
      metadata,
      ...(isMember && member.email ? { receipt_email: member.email } : {})
    });

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: creds.publishable_key,
      amount: totalAmountMinor,
      currency,
      discounted_price: finalPrice,
      original_price: ticket.price
    });
  } catch (error) {
    console.error('[Complex Event Payment Intent] Error:', error);
    return res.status(500).json({ error: 'Failed to create payment intent' });
  }
}
