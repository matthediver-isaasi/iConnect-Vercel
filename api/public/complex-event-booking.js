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
      attendees: legacyAttendees,
      ticket_class_id: legacyTicketClassId,
      payment_method,
      stripe_payment_intent_id,
      discount_code: legacyDiscountCode,
      items
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

    const isMultiTicket = Array.isArray(items) && items.length > 0;

    const normalizedItems = isMultiTicket
      ? items
      : [{
          ticket_class_id: legacyTicketClassId,
          attendees: legacyAttendees,
          discount_code: legacyDiscountCode
        }];

    for (const item of normalizedItems) {
      if (!item.attendees || !Array.isArray(item.attendees) || item.attendees.length === 0) {
        return res.status(400).json({ error: 'At least one attendee is required per ticket type' });
      }
    }

    const { data: event, error: eventError } = await supabase
      .from('complex_event')
      .select('id, title, status, event_state, tenant_id')
      .eq('id', event_id)
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc'])
      .single();

    if (eventError || !event) return res.status(404).json({ error: 'Event not found' });

    if (event.event_state === 'draft') {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (event.event_state === 'closed') {
      return res.status(400).json({ error: 'Registration for this event is closed' });
    }

    const { data: ticketClassRows } = await supabase
      .from('complex_event_ticket_class')
      .select('*')
      .eq('complex_event_id', event_id)
      .eq('tenant_id', tenant.id);

    const allTicketClasses = ticketClassRows || [];
    const hasTicketClasses = allTicketClasses.length > 0;
    const isMember = !!authenticatedMember;

    let grandTotalMinor = 0;
    let unifiedCurrency = null;
    const resolvedItems = [];

    for (const item of normalizedItems) {
      if (hasTicketClasses && !item.ticket_class_id) {
        return res.status(400).json({ error: 'ticket_class_id is required when ticket classes are configured' });
      }

      const ticketClass = item.ticket_class_id ? getTicketClassFromConfig(allTicketClasses, item.ticket_class_id) : null;
      if (item.ticket_class_id && !ticketClass) {
        return res.status(400).json({ error: `Invalid ticket class: ${item.ticket_class_id}` });
      }

      if (ticketClass && !isTicketVisibleToUser(ticketClass, isMember)) {
        return res.status(403).json({ error: 'You do not have access to this ticket class' });
      }

      const serverTicket = resolveTicketPrice(allTicketClasses, item.ticket_class_id);
      let authoritativePrice = ticketClass?.is_free ? 0 : serverTicket.price;
      const ticketCurrency = (serverTicket.currency || 'gbp').toLowerCase();
      if (unifiedCurrency === null) {
        unifiedCurrency = ticketCurrency;
      } else if (ticketCurrency !== unifiedCurrency) {
        return res.status(400).json({ error: 'All ticket classes must use the same currency' });
      }

      let validatedDiscountCode = null;
      let discountAmount = 0;

      if (item.discount_code && authoritativePrice > 0) {
        const discountResult = await validateDiscountCode({
          code: item.discount_code,
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

      const attendeeCount = item.attendees.length;
      const itemTotalMinor = Math.round(authoritativePrice * attendeeCount * 100);
      grandTotalMinor += itemTotalMinor;

      resolvedItems.push({
        ticket_class_id: item.ticket_class_id,
        ticketClass,
        serverTicket,
        authoritativePrice,
        ticketCurrency,
        validatedDiscountCode,
        discountAmount,
        attendees: item.attendees
      });
    }

    const isFree = grandTotalMinor === 0;

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

          if (paymentIntent.amount !== grandTotalMinor) {
            console.error(`[Complex Event Booking] Stripe amount mismatch: intent=${paymentIntent.amount}, expected=${grandTotalMinor}`);
            return res.status(400).json({ error: 'Payment amount does not match the ticket price' });
          }

          const firstCurrency = resolvedItems[0]?.ticketCurrency || 'gbp';
          const intentCurrency = (paymentIntent.currency || '').toLowerCase();
          if (intentCurrency !== firstCurrency.toLowerCase()) {
            return res.status(400).json({ error: 'Payment currency does not match' });
          }

          const piEventId = paymentIntent.metadata?.event_id;
          if (!piEventId || piEventId !== event_id) {
            return res.status(400).json({ error: 'Payment intent does not match this event' });
          }

          if (!isMultiTicket) {
            const piTicketClassId = paymentIntent.metadata?.ticket_class_id;
            if (piTicketClassId && piTicketClassId !== legacyTicketClassId) {
              return res.status(400).json({ error: 'Payment intent does not match this ticket class' });
            }
          }
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
        const totalInPounds = grandTotalMinor / 100;
        if (organization_id) {
          const { data: org } = await supabase
            .from('organization')
            .select('id, account_balance')
            .eq('id', organization_id)
            .single();
          if (!org || (org.account_balance || 0) < totalInPounds) {
            return res.status(400).json({ error: 'Insufficient account balance' });
          }
        }
        paymentStatus = 'pending';
        confirmedPaymentMethod = 'account_balance';
      } else if (payment_method === 'training_fund') {
        if (!authenticatedMember) {
          return res.status(401).json({ error: 'You must be logged in to use training fund payment' });
        }
        const totalInPounds = grandTotalMinor / 100;
        if (organization_id) {
          const { data: org } = await supabase
            .from('organization')
            .select('id, training_fund_balance, training_fund_allowed_role_ids')
            .eq('id', organization_id)
            .single();
          if (!org || (org.training_fund_balance || 0) < totalInPounds) {
            return res.status(400).json({ error: 'Insufficient training fund balance' });
          }
          const tfAllowedRoles = org.training_fund_allowed_role_ids || [];
          if (tfAllowedRoles.length > 0) {
            const memberRoleId = authenticatedMember.role_id;
            if (!memberRoleId || !tfAllowedRoles.includes(memberRoleId)) {
              return res.status(403).json({ error: 'Your role does not have permission to use the training fund' });
            }
          }
        }
        paymentStatus = 'pending';
        confirmedPaymentMethod = 'training_fund';
      } else if (payment_method === 'voucher') {
        if (!authenticatedMember) {
          return res.status(401).json({ error: 'You must be logged in to use voucher payment' });
        }
        if (organization_id) {
          const { data: org } = await supabase
            .from('organization')
            .select('id, voucher_allowed_role_ids')
            .eq('id', organization_id)
            .single();
          if (org) {
            const vAllowedRoles = org.voucher_allowed_role_ids || [];
            if (vAllowedRoles.length > 0) {
              const memberRoleId = authenticatedMember.role_id;
              if (!memberRoleId || !vAllowedRoles.includes(memberRoleId)) {
                return res.status(403).json({ error: 'Your role does not have permission to use training vouchers' });
              }
            }
          }
        }
        paymentStatus = 'pending';
        confirmedPaymentMethod = 'voucher';
      }
    }

    const allAttendeeEmails = [];
    for (const item of resolvedItems) {
      for (const attendee of item.attendees) {
        const email = (attendee.email || '').toLowerCase().trim();
        if (email) allAttendeeEmails.push(email);
      }
    }

    const emailSet = new Set();
    for (const email of allAttendeeEmails) {
      if (emailSet.has(email)) {
        return res.status(400).json({ error: `Duplicate email in request: ${email}` });
      }
      emailSet.add(email);
    }

    const duplicateEmails = [];
    for (const email of allAttendeeEmails) {
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
    let isFirstAttendeeOverall = true;

    for (const item of resolvedItems) {
      for (let i = 0; i < item.attendees.length; i++) {
        const attendee = item.attendees[i];
        const email = (attendee.email || '').toLowerCase().trim();
        if (!email || !email.includes('@')) {
          return res.status(400).json({ error: `Invalid email address: ${attendee.email}` });
        }

        const bookingRef = generateBookingReference();
        const isFirstInGroup = i === 0;
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
          ticket_class_id: item.ticket_class_id || null,
          ticket_class_name: item.serverTicket.name || null,
          ticket_price: item.authoritativePrice,
          payment_method: confirmedPaymentMethod,
          payment_status: paymentStatus,
          stripe_payment_intent_id: isFirstAttendeeOverall ? (stripe_payment_intent_id || null) : null,
          discount_code: isFirstInGroup && item.validatedDiscountCode ? item.validatedDiscountCode.code : null,
          discount_amount: isFirstInGroup ? item.discountAmount : 0,
          total_paid: paymentStatus === 'paid' ? item.authoritativePrice : 0,
          currency: item.ticketCurrency,
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
        isFirstAttendeeOverall = false;
      }

      if (item.validatedDiscountCode) {
        try {
          await recordDiscountCodeUsage({
            discountCodeRecord: item.validatedDiscountCode,
            tenantId: tenant.id,
            orgId: organization_id,
            memberId: member_id
          });
        } catch (e) {
          console.error('[Complex Event Booking] Failed to record discount code usage:', e);
        }
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
