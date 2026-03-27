import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getSessionMember } from '../_lib/session.js';
import { getStripeCredentials } from '../_lib/stripeCredentials.js';
import {
  resolveTicketPrice,
  getTicketClassFromConfig,
  isTicketVisibleToUser,
  validateDiscountCode,
  computeDiscountedPrice,
  recordDiscountCodeUsage
} from '../_lib/complexEventPricing.js';

function generateBookingReference() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let ref = 'CEB-';
  for (let i = 0; i < 8; i++) {
    ref += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return ref;
}

function eventHasTicketClasses(pricingConfig) {
  let parsed = pricingConfig;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return false; }
  }
  return !!(parsed?.ticket_classes?.length);
}

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

    const {
      event_id,
      attendees,
      ticket_class_id,
      payment_method,
      stripe_payment_intent_id,
      discount_code
    } = req.body;

    let authenticatedMember = null;
    try {
      const sessionMember = await getSessionMember(req);
      if (sessionMember) {
        const memberTenantId = sessionMember.organization?.tenant_id || sessionMember.tenant_id;
        if (memberTenantId && memberTenantId === tenant.id) {
          authenticatedMember = sessionMember;
        }
      }
    } catch (e) {}
    const member_id = authenticatedMember?.id || null;
    const organization_id = authenticatedMember?.organization_id || null;

    if (!event_id) return res.status(400).json({ error: 'event_id is required' });
    if (!attendees || !Array.isArray(attendees) || attendees.length === 0) {
      return res.status(400).json({ error: 'At least one attendee is required' });
    }

    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('id, title, status, is_complex, tenant_id, pricing_config, registration_closes_at')
      .eq('id', event_id)
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc'])
      .single();

    if (eventError || !event) return res.status(404).json({ error: 'Event not found' });
    if (!event.is_complex) return res.status(400).json({ error: 'This endpoint is for complex events only' });
    if (event.registration_closes_at && new Date(event.registration_closes_at) < new Date()) {
      return res.status(400).json({ error: 'Registration for this event has closed' });
    }

    const hasTicketClasses = eventHasTicketClasses(event.pricing_config);
    if (hasTicketClasses && !ticket_class_id) {
      return res.status(400).json({ error: 'ticket_class_id is required when ticket classes are configured' });
    }

    const isMember = !!authenticatedMember;

    const ticketClass = ticket_class_id ? getTicketClassFromConfig(event.pricing_config, ticket_class_id) : null;
    if (ticket_class_id && !ticketClass) {
      return res.status(400).json({ error: 'Invalid ticket class' });
    }

    if (ticketClass && !isTicketVisibleToUser(ticketClass, isMember)) {
      return res.status(403).json({ error: 'You do not have access to this ticket class' });
    }

    const serverTicket = resolveTicketPrice(event.pricing_config, ticket_class_id);
    let authoritativePrice = serverTicket.price;
    const ticketCurrency = serverTicket.currency || 'gbp';

    let validatedDiscountCode = null;
    let discountAmount = 0;

    if (discount_code && authoritativePrice > 0) {
      const discountResult = await validateDiscountCode({
        code: discount_code,
        tenantId: tenant.id,
        eventId: event_id,
        memberId: isMember ? authenticatedMember.id : null,
        memberRoleId: isMember ? authenticatedMember.role_id : null,
        orgId: isMember ? authenticatedMember.organization_id : null
      });

      if (discountResult.valid) {
        const discountedPrice = computeDiscountedPrice(authoritativePrice, discountResult.discountCode);
        discountAmount = authoritativePrice - discountedPrice;
        authoritativePrice = discountedPrice;
        validatedDiscountCode = discountResult.discountCode;
      } else {
        return res.status(400).json({ error: discountResult.reason });
      }
    }

    const isFree = authoritativePrice === 0;
    const attendeeCount = attendees.length;
    const expectedTotalMinor = Math.round(authoritativePrice * attendeeCount * 100);

    let paymentStatus = 'free';
    let confirmedPaymentMethod = 'free';

    if (!isFree) {
      const validPaidMethods = ['card', 'account', 'account_balance', 'training_fund', 'voucher', 'invoice'];
      if (!payment_method || !validPaidMethods.includes(payment_method)) {
        return res.status(400).json({
          error: `Invalid payment method. Supported methods: ${validPaidMethods.join(', ')}`
        });
      }

      if (payment_method === 'card') {
        if (!stripe_payment_intent_id) {
          return res.status(400).json({ error: 'stripe_payment_intent_id is required for card payments' });
        }

        const { data: existingWithIntent } = await supabase
          .from('complex_event_booking')
          .select('id')
          .eq('stripe_payment_intent_id', stripe_payment_intent_id)
          .limit(1);

        if (existingWithIntent && existingWithIntent.length > 0) {
          return res.status(409).json({ error: 'This payment has already been used for a booking' });
        }

        let stripeSecretKey;
        try {
          const creds = await getStripeCredentials(tenant.id, 'events');
          stripeSecretKey = creds?.secret_key;
        } catch (e) {
          console.error('[Complex Event Booking] Failed to get Stripe credentials:', e);
        }
        if (!stripeSecretKey) {
          return res.status(503).json({ error: 'Payment processing not configured' });
        }

        try {
          const stripeResponse = await fetch(`https://api.stripe.com/v1/payment_intents/${stripe_payment_intent_id}`, {
            headers: { 'Authorization': `Bearer ${stripeSecretKey}` }
          });
          const paymentIntent = await stripeResponse.json();

          if (paymentIntent.status !== 'succeeded') {
            return res.status(400).json({ error: 'Payment has not been completed' });
          }

          if (paymentIntent.amount !== expectedTotalMinor) {
            console.error(`[Complex Event Booking] Stripe amount mismatch: intent=${paymentIntent.amount}, expected=${expectedTotalMinor}`);
            return res.status(400).json({ error: 'Payment amount does not match the ticket price' });
          }

          const intentCurrency = (paymentIntent.currency || '').toLowerCase();
          if (intentCurrency !== ticketCurrency.toLowerCase()) {
            return res.status(400).json({ error: 'Payment currency does not match' });
          }

          const piEventId = paymentIntent.metadata?.event_id;
          if (!piEventId || piEventId !== event_id) {
            return res.status(400).json({ error: 'Payment intent does not match this event' });
          }

          const piTicketClassId = paymentIntent.metadata?.ticket_class_id;
          if (piTicketClassId && piTicketClassId !== ticket_class_id) {
            return res.status(400).json({ error: 'Payment intent does not match this ticket class' });
          }

          authoritativePrice = paymentIntent.amount / 100 / attendeeCount;
        } catch (stripeErr) {
          console.error('[Complex Event Booking] Stripe verification error:', stripeErr);
          return res.status(500).json({ error: 'Failed to verify payment' });
        }

        paymentStatus = 'paid';
        confirmedPaymentMethod = 'card';
      } else if (payment_method === 'account' || payment_method === 'invoice') {
        if (!authenticatedMember) {
          return res.status(401).json({ error: 'You must be logged in to use this payment method' });
        }
        paymentStatus = 'pending';
        confirmedPaymentMethod = payment_method;
      } else if (payment_method === 'account_balance') {
        if (!authenticatedMember) {
          return res.status(401).json({ error: 'You must be logged in to use account balance payment' });
        }
        if (organization_id) {
          const { data: org } = await supabase
            .from('organization')
            .select('id, account_balance')
            .eq('id', organization_id)
            .single();
          if (!org || (org.account_balance || 0) < authoritativePrice * attendeeCount) {
            return res.status(400).json({ error: 'Insufficient account balance' });
          }
        }
        paymentStatus = 'pending';
        confirmedPaymentMethod = 'account_balance';
      } else if (payment_method === 'training_fund') {
        if (!authenticatedMember) {
          return res.status(401).json({ error: 'You must be logged in to use training fund payment' });
        }
        if (organization_id) {
          const { data: org } = await supabase
            .from('organization')
            .select('id, training_fund_balance')
            .eq('id', organization_id)
            .single();
          if (!org || (org.training_fund_balance || 0) < authoritativePrice * attendeeCount) {
            return res.status(400).json({ error: 'Insufficient training fund balance' });
          }
        }
        paymentStatus = 'pending';
        confirmedPaymentMethod = 'training_fund';
      } else if (payment_method === 'voucher') {
        if (!authenticatedMember) {
          return res.status(401).json({ error: 'You must be logged in to use voucher payment' });
        }
        paymentStatus = 'pending';
        confirmedPaymentMethod = 'voucher';
      }
    }

    const duplicateEmails = [];
    for (const attendee of attendees) {
      const email = (attendee.email || '').toLowerCase().trim();
      if (!email) continue;

      const { data: existing } = await supabase
        .from('complex_event_booking')
        .select('id, attendee_email')
        .eq('tenant_id', tenant.id)
        .eq('event_id', event_id)
        .ilike('attendee_email', email)
        .in('status', ['confirmed', 'pending'])
        .limit(1);

      if (existing && existing.length > 0) {
        duplicateEmails.push(email);
      }
    }

    if (duplicateEmails.length > 0) {
      return res.status(409).json({
        error: 'Duplicate registration detected',
        duplicates: duplicateEmails,
        message: `The following email(s) are already registered: ${duplicateEmails.join(', ')}`
      });
    }

    const bookingGroupRef = generateBookingReference();
    const bookings = [];

    for (let i = 0; i < attendees.length; i++) {
      const attendee = attendees[i];
      const email = (attendee.email || '').toLowerCase().trim();
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: `Invalid email address: ${attendee.email}` });
      }

      const bookingRef = generateBookingReference();
      const isFirstAttendee = i === 0;
      const bookingData = {
        tenant_id: tenant.id,
        event_id,
        booking_reference: bookingRef,
        attendee_email: email,
        attendee_first_name: attendee.first_name || null,
        attendee_last_name: attendee.last_name || null,
        attendee_organization: attendee.organization || null,
        attendee_phone: attendee.phone || null,
        attendee_job_title: attendee.job_title || null,
        member_id: member_id || null,
        organization_id: organization_id || null,
        ticket_class_id: ticket_class_id || null,
        ticket_class_name: serverTicket.name || null,
        ticket_price: authoritativePrice,
        payment_method: confirmedPaymentMethod,
        payment_status: paymentStatus,
        stripe_payment_intent_id: isFirstAttendee ? (stripe_payment_intent_id || null) : null,
        discount_code: isFirstAttendee && validatedDiscountCode ? validatedDiscountCode.code : null,
        discount_amount: isFirstAttendee ? discountAmount : 0,
        total_paid: paymentStatus === 'paid' ? authoritativePrice : 0,
        currency: ticketCurrency,
        status: (isFree || paymentStatus === 'paid') ? 'confirmed' : 'pending',
        booking_group_reference: bookingGroupRef
      };

      const { data: booking, error: insertError } = await supabase
        .from('complex_event_booking')
        .insert(bookingData)
        .select()
        .single();

      if (insertError) {
        console.error('[Complex Event Booking] Insert error:', insertError);
        if (insertError.code === '23505') {
          return res.status(409).json({
            error: 'Duplicate registration',
            message: `${email} is already registered for this event`
          });
        }
        return res.status(500).json({ error: 'Failed to create booking' });
      }

      bookings.push(booking);
    }

    if (validatedDiscountCode) {
      try {
        await recordDiscountCodeUsage({
          discountCodeRecord: validatedDiscountCode,
          tenantId: tenant.id,
          orgId: organization_id,
          memberId: member_id
        });
      } catch (e) {
        console.error('[Complex Event Booking] Failed to record discount code usage:', e);
      }
    }

    return res.status(201).json({
      success: true,
      booking_group_reference: bookingGroupRef,
      bookings,
      event_title: event.title
    });
  } catch (error) {
    console.error('[Complex Event Booking] Error:', error);
    return res.status(500).json({ error: 'Failed to process booking' });
  }
}
