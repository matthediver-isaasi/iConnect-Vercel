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
import {
  ticketHasAccessRestrictions,
  isTicketAccessibleToMember,
  getMemberGroupIdsForMember
} from '../_lib/ticketAccess.js';
import { getValidXeroAccessToken, findOrCreateXeroContact } from '../_lib/xero.js';
import { sendConfirmationEmailsFromTemplate } from '../_lib/eventConfirmationEmail.js';

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
      items,
      selected_voucher_ids,
      training_fund_amount: requestedTrainingFundAmount,
      purchase_order_number: purchaseOrderNumber,
      po_to_follow: poToFollow,
      third_party_consent: thirdPartyConsent
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
      .select('id, title, status, event_state, tenant_id, available_seats, internal_reference, xero_account_code, pricing_config')
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

    // Block registration once an admin has started the safe-deletion flow
    // (status='cancelling'). See task-700 / api/_lib/eventDeletion.js.
    if (event.status === 'cancelling') {
      return res.status(400).json({ error: 'This event is being cancelled and is no longer accepting bookings' });
    }

    const { data: ticketClassRows } = await supabase
      .from('complex_event_ticket_class')
      .select('*')
      .eq('complex_event_id', event_id)
      .eq('tenant_id', tenant.id);

    const allTicketClasses = ticketClassRows || [];
    const hasTicketClasses = allTicketClasses.length > 0;
    const isMember = !!authenticatedMember;

    // Cache the authenticated member's group assignments. Only loaded if any
    // ticket in the booking is restricted by roles/groups.
    let cachedMemberGroupIds = null;
    const loadMemberGroupIds = async () => {
      if (!isMember) return [];
      if (cachedMemberGroupIds !== null) return cachedMemberGroupIds;
      cachedMemberGroupIds = await getMemberGroupIdsForMember(supabase, authenticatedMember.id);
      return cachedMemberGroupIds;
    };

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

      if (ticketClass && ticketHasAccessRestrictions(ticketClass)) {
        if (!isMember) {
          return res.status(403).json({ error: 'You do not have access to this ticket class' });
        }
        const memberGroupIds = await loadMemberGroupIds();
        const allowed = isTicketAccessibleToMember({
          ticketClass,
          memberRoleId: authenticatedMember.role_id,
          memberGroupIds
        });
        if (!allowed) {
          return res.status(403).json({ error: 'You do not have access to this ticket class' });
        }
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
          orgId: isMember ? authenticatedMember.organization_id : null,
          ticketClassId: item.ticket_class_id
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
    const totalCostPounds = grandTotalMinor / 100;

    let paymentStatus = 'free';
    let confirmedPaymentMethod = 'free';

    let org = null;
    if (organization_id) {
      const { data: orgData } = await supabase
        .from('organization')
        .select('id, name, account_balance, training_fund_balance, training_fund_allowed_role_ids, voucher_allowed_role_ids, invoicing_email, address')
        .eq('id', organization_id)
        .single();
      org = orgData;
    }

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

          const maxReasonableAmount = grandTotalMinor + 100;
          if (paymentIntent.amount > maxReasonableAmount) {
            console.error(`[Complex Event Booking] Stripe amount exceeds expected maximum: intent=${paymentIntent.amount}, max=${maxReasonableAmount}`);
            return res.status(400).json({ error: 'Payment amount exceeds expected total' });
          }

          let maxServerDeductionsMinor = 0;
          if (org) {
            if (requestedTrainingFundAmount > 0) {
              maxServerDeductionsMinor += Math.round(Math.min(requestedTrainingFundAmount, org.training_fund_balance || 0, totalCostPounds) * 100);
            }
            if (selected_voucher_ids && selected_voucher_ids.length > 0) {
              const { data: vouchersForCheck } = await supabase
                .from('voucher')
                .select('id, value')
                .in('id', selected_voucher_ids)
                .eq('status', 'active')
                .eq('organization_id', org.id);
              if (vouchersForCheck) {
                const totalVoucherValue = vouchersForCheck.reduce((sum, v) => sum + (v.value || 0), 0);
                maxServerDeductionsMinor += Math.round(Math.min(totalVoucherValue, totalCostPounds) * 100);
              }
            }
          }
          maxServerDeductionsMinor = Math.min(maxServerDeductionsMinor, grandTotalMinor);
          const minExpectedPence = Math.max(0, grandTotalMinor - maxServerDeductionsMinor);
          if (paymentIntent.amount < minExpectedPence - 100) {
            console.error(`[Complex Event Booking] Stripe amount too low: intent=${paymentIntent.amount}, minExpected=${minExpectedPence}`);
            return res.status(400).json({ error: 'Payment amount is insufficient for this booking' });
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
        if (!org) {
          return res.status(400).json({ error: 'Organization is required for account balance payment' });
        }
        if ((org.account_balance || 0) < totalCostPounds) {
          return res.status(400).json({ error: 'Insufficient account balance' });
        }
        paymentStatus = 'paid';
        confirmedPaymentMethod = 'account_balance';
      } else if (payment_method === 'training_fund') {
        if (!authenticatedMember) {
          return res.status(401).json({ error: 'You must be logged in to use training fund payment' });
        }
        if (!org) {
          return res.status(400).json({ error: 'Organization is required for training fund payment' });
        }
        if ((org.training_fund_balance || 0) < totalCostPounds) {
          return res.status(400).json({ error: 'Insufficient training fund balance' });
        }
        const tfAllowedRoles = org.training_fund_allowed_role_ids || [];
        if (tfAllowedRoles.length > 0) {
          const memberRoleId = authenticatedMember.role_id;
          if (!memberRoleId || !tfAllowedRoles.includes(memberRoleId)) {
            return res.status(403).json({ error: 'Your role does not have permission to use the training fund' });
          }
        }
        paymentStatus = 'paid';
        confirmedPaymentMethod = 'training_fund';
      } else if (payment_method === 'voucher') {
        if (!authenticatedMember) {
          return res.status(401).json({ error: 'You must be logged in to use voucher payment' });
        }
        if (!org) {
          return res.status(400).json({ error: 'Organization is required for voucher payment' });
        }
        const vAllowedRoles = org.voucher_allowed_role_ids || [];
        if (vAllowedRoles.length > 0) {
          const memberRoleId = authenticatedMember.role_id;
          if (!memberRoleId || !vAllowedRoles.includes(memberRoleId)) {
            return res.status(403).json({ error: 'Your role does not have permission to use training vouchers' });
          }
        }
        paymentStatus = 'paid';
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

    let validatedTrainingFundAmount = 0;
    let voucherAmountApplied = 0;
    const voucherDeductions = [];
    const validatedVouchers = [];

    if (!isFree && authenticatedMember && org) {
      if (confirmedPaymentMethod === 'training_fund' || (requestedTrainingFundAmount && requestedTrainingFundAmount > 0)) {
        const tfAllowedRoles = org.training_fund_allowed_role_ids || [];
        if (tfAllowedRoles.length > 0) {
          const memberRoleId = authenticatedMember.role_id;
          if (!memberRoleId || !tfAllowedRoles.includes(memberRoleId)) {
            return res.status(403).json({ error: 'Your role does not have permission to use the training fund' });
          }
        }
        const tfAmount = confirmedPaymentMethod === 'training_fund'
          ? totalCostPounds
          : Math.max(0, requestedTrainingFundAmount || 0);
        validatedTrainingFundAmount = Math.min(tfAmount, org.training_fund_balance || 0, totalCostPounds);
      }

      if ((confirmedPaymentMethod === 'voucher' || (selected_voucher_ids && selected_voucher_ids.length > 0)) && org) {
        const vAllowedRoles = org.voucher_allowed_role_ids || [];
        if (vAllowedRoles.length > 0) {
          const memberRoleId = authenticatedMember.role_id;
          if (!memberRoleId || !vAllowedRoles.includes(memberRoleId)) {
            return res.status(403).json({ error: 'Your role does not have permission to use training vouchers' });
          }
        }
        const voucherIds = selected_voucher_ids || [];

        if (confirmedPaymentMethod === 'voucher' && voucherIds.length === 0) {
          return res.status(400).json({ error: 'selected_voucher_ids is required for voucher payment' });
        }

        for (const voucherId of voucherIds) {
          const { data: voucher } = await supabase
            .from('voucher')
            .select('*')
            .eq('id', voucherId)
            .eq('organization_id', org.id)
            .eq('status', 'active')
            .single();

          if (voucher && voucher.value > 0) {
            const amountToUse = Math.min(voucher.value, totalCostPounds - voucherAmountApplied - validatedTrainingFundAmount);
            if (amountToUse > 0) {
              voucherAmountApplied += amountToUse;
              validatedVouchers.push({ voucherId, amount: amountToUse, originalValue: voucher.value });
            }
          } else {
            console.warn('[Complex Event Booking] Voucher not found or not owned by org:', voucherId);
          }
        }

        if (confirmedPaymentMethod === 'voucher') {
          const totalCoverage = voucherAmountApplied + validatedTrainingFundAmount;
          if (totalCoverage < totalCostPounds) {
            return res.status(400).json({
              error: `Vouchers do not cover the full cost. Total: £${totalCostPounds.toFixed(2)}, Coverage: £${totalCoverage.toFixed(2)}`
            });
          }
        }
      }
    }

    const totalAttendees = resolvedItems.reduce((sum, item) => sum + item.attendees.length, 0);

    const ticketClassCounts = {};
    for (const item of resolvedItems) {
      if (item.ticket_class_id) {
        ticketClassCounts[item.ticket_class_id] = (ticketClassCounts[item.ticket_class_id] || 0) + item.attendees.length;
      }
    }

    if (event.available_seats !== null && event.available_seats !== undefined) {
      const { data: newSeats, error: seatError } = await supabase.rpc('atomic_decrement_complex_event_seats', {
        p_event_id: event_id,
        p_count: totalAttendees
      });

      if (seatError) {
        console.error(`[Complex Event Booking] Atomic seat decrement failed: ${seatError.message}`);
        return res.status(409).json({ error: 'Not enough seats available for this event' });
      }
      console.log(`[Complex Event Booking] Atomically decremented complex_event seats to ${newSeats}`);
    }

    let seatsDecrementedForEvent = event.available_seats !== null && event.available_seats !== undefined;
    const ticketClassSeatsDecremented = [];

    for (const [tcId, count] of Object.entries(ticketClassCounts)) {
      const tc = allTicketClasses.find(t => String(t.id) === String(tcId));
      if (tc && !tc.is_unlimited_tickets && tc.available_count !== null && tc.available_count !== undefined) {
        const { data: newCount, error: tcErr } = await supabase.rpc('atomic_decrement_ticket_class_seats', {
          p_ticket_class_id: tcId,
          p_count: count
        });

        if (tcErr) {
          console.error(`[Complex Event Booking] Atomic ticket class seat decrement failed for '${tc.name}': ${tcErr.message}`);

          if (seatsDecrementedForEvent) {
            const { data: curEvt } = await supabase.from('complex_event').select('available_seats').eq('id', event_id).single();
            if (curEvt) {
              await supabase.from('complex_event').update({ available_seats: curEvt.available_seats + totalAttendees }).eq('id', event_id)
                .then(({ error }) => { if (error) console.error('[Complex Event Booking] Seat restore error:', error.message); });
            }
          }
          for (const prev of ticketClassSeatsDecremented) {
            const { data: curTc } = await supabase.from('complex_event_ticket_class').select('available_count').eq('id', prev.tcId).single();
            if (curTc) {
              await supabase.from('complex_event_ticket_class').update({ available_count: curTc.available_count + prev.count }).eq('id', prev.tcId)
                .then(({ error }) => { if (error) console.error('[Complex Event Booking] Ticket class seat restore error:', error.message); });
            }
          }
          return res.status(409).json({ error: `Not enough seats available for ticket class '${tc.name}'` });
        }
        ticketClassSeatsDecremented.push({ tcId, count });
        console.log(`[Complex Event Booking] Atomically decremented ticket class '${tc.name}' availability to ${newCount}`);
      }
    }

    const bookingGroupRef = generateBookingReference();
    const bookings = [];
    const usedDiscountCodes = [];
    let isFirstAttendeeOverall = true;

    const restoreSeats = async () => {
      if (seatsDecrementedForEvent) {
        const { data: currentEvent } = await supabase
          .from('complex_event')
          .select('available_seats')
          .eq('id', event_id)
          .single();
        if (currentEvent) {
          await supabase
            .from('complex_event')
            .update({ available_seats: currentEvent.available_seats + totalAttendees })
            .eq('id', event_id)
            .catch(e => console.error('[Complex Event Booking] Failed to restore event seats:', e.message));
        }
      }
      for (const prev of ticketClassSeatsDecremented) {
        const { data: currentTc } = await supabase
          .from('complex_event_ticket_class')
          .select('available_count')
          .eq('id', prev.tcId)
          .single();
        if (currentTc) {
          await supabase
            .from('complex_event_ticket_class')
            .update({ available_count: currentTc.available_count + prev.count })
            .eq('id', prev.tcId)
            .catch(e => console.error('[Complex Event Booking] Failed to restore ticket class seats:', e.message));
        }
      }
    };

    for (const item of resolvedItems) {
      for (let i = 0; i < item.attendees.length; i++) {
        const attendee = item.attendees[i];
        const email = (attendee.email || '').toLowerCase().trim();
        if (!email || !email.includes('@')) {
          await restoreSeats();
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
          status: 'confirmed',
          booking_group_reference: bookingGroupRef,
          training_fund_amount: validatedTrainingFundAmount > 0 ? validatedTrainingFundAmount / totalAttendees : 0,
          voucher_amount: voucherAmountApplied > 0 ? voucherAmountApplied / totalAttendees : 0,
          voucher_id: validatedVouchers.length > 0 ? validatedVouchers[0].voucherId : null,
          account_balance_amount: confirmedPaymentMethod === 'account_balance' ? totalCostPounds / totalAttendees : 0,
          purchase_order_number: purchaseOrderNumber || null,
          po_to_follow: (confirmedPaymentMethod === 'account' || confirmedPaymentMethod === 'invoice') ? (poToFollow || false) : false,
          third_party_consent: (event.pricing_config?.collectThirdPartyConsent === true && typeof thirdPartyConsent === 'boolean') ? thirdPartyConsent : null
        };

        const { data: booking, error: insertError } = await supabase
          .from('complex_event_booking')
          .insert(bookingData)
          .select()
          .single();

        if (insertError) {
          console.error('[Complex Event Booking] Insert error:', insertError);
          await restoreSeats();
          if (bookings.length > 0) {
            await supabase
              .from('complex_event_booking')
              .delete()
              .eq('booking_group_reference', bookingGroupRef);
          }
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
          usedDiscountCodes.push({
            id: item.validatedDiscountCode.id,
            currentUsageCount: item.validatedDiscountCode.current_usage_count || 0,
            isMemberTargeted: !!(item.validatedDiscountCode.member_id || item.validatedDiscountCode.role_id || item.validatedDiscountCode.member_group_id)
          });
        } catch (e) {
          console.error('[Complex Event Booking] Failed to record discount code usage:', e);
        }
      }
    }

    const firstBookingRef = bookings[0]?.booking_reference || bookingGroupRef;
    let actualTrainingFundApplied = 0;

    const rollbackBookingsAndSeats = async () => {
      await restoreSeats();
      if (bookings.length > 0) {
        await supabase
          .from('complex_event_booking')
          .delete()
          .eq('booking_group_reference', bookingGroupRef);
      }
      for (const dc of usedDiscountCodes) {
        if (!dc.isMemberTargeted) {
          const { error: dcErr } = await supabase
            .from('discount_code')
            .update({ current_usage_count: Math.max(0, (dc.currentUsageCount || 1) - 1) })
            .eq('id', dc.id);
          if (dcErr) console.error('[Complex Event Booking] Discount code rollback error:', dcErr.message);
        }
      }
    };

    const rollbackFinancialDeductions = async () => {
      for (const d of voucherDeductions) {
        const { error: vRestoreErr } = await supabase
          .from('voucher')
          .update({ value: d.originalValue, status: 'active' })
          .eq('id', d.voucherId);
        if (vRestoreErr) console.error('[Complex Event Booking] Voucher rollback error:', vRestoreErr.message);
        const { error: vtDeleteErr } = await supabase
          .from('voucher_transaction')
          .delete()
          .eq('voucher_id', d.voucherId)
          .eq('booking_reference', firstBookingRef)
          .eq('type', 'booking_usage');
        if (vtDeleteErr) console.error('[Complex Event Booking] Voucher transaction rollback error:', vtDeleteErr.message);
      }
      if (actualTrainingFundApplied > 0 && org) {
        const { error: tfRestoreErr } = await supabase
          .from('organization')
          .update({ training_fund_balance: (org.training_fund_balance || 0) })
          .eq('id', org.id);
        if (tfRestoreErr) console.error('[Complex Event Booking] Training fund rollback error:', tfRestoreErr.message);
        const { error: tftDeleteErr } = await supabase
          .from('training_fund_transaction')
          .delete()
          .eq('organization_id', org.id)
          .eq('type', 'booking_usage')
          .like('reason', `%${firstBookingRef}%`);
        if (tftDeleteErr) console.error('[Complex Event Booking] Training fund transaction rollback error:', tftDeleteErr.message);
        actualTrainingFundApplied = 0;
      }
    };

    if (!isFree && authenticatedMember && org) {
      let deductionFailed = false;

      for (const v of validatedVouchers) {
        const newValue = v.originalValue - v.amount;
        console.log('[Complex Event Booking] Deducting voucher', v.voucherId, 'by', v.amount);
        const { data: updatedVoucher, error: updateError } = await supabase
          .from('voucher')
          .update({
            value: newValue,
            status: newValue <= 0 ? 'used' : 'active'
          })
          .eq('id', v.voucherId)
          .gte('value', v.amount)
          .select('value')
          .single();

        if (updateError || !updatedVoucher) {
          console.error('[Complex Event Booking] Guarded voucher update failed:', v.voucherId);
          if (confirmedPaymentMethod === 'voucher') {
            deductionFailed = true;
            break;
          }
        } else {
          voucherDeductions.push(v);

          if (!tenant?.id) {
            console.error('[Complex Event Booking] Refusing to write voucher_transaction with NULL tenant_id', {
              eventId: event.id,
              orgId: org.id,
              voucherId: v.voucherId,
              firstBookingRef,
            });
            await rollbackFinancialDeductions();
            await rollbackBookingsAndSeats();
            return res.status(500).json({ error: 'Could not resolve tenant context for voucher transaction' });
          }
          const { error: vtxError } = await supabase
            .from('voucher_transaction')
            .insert({
              voucher_id: v.voucherId,
              organization_id: org.id,
              booking_reference: firstBookingRef,
              event_id: event.id,
              event_title: event.title || 'Complex Event',
              member_id: member_id || null,
              member_email: authenticatedMember.email || null,
              amount: v.amount,
              balance_before: v.originalValue,
              balance_after: updatedVoucher.value,
              type: 'booking_usage',
              created_at: new Date().toISOString(),
              tenant_id: tenant.id
            });

          if (vtxError) {
            console.error('[Complex Event Booking] Failed to create voucher transaction:', vtxError.message);
          } else {
            console.log('[Complex Event Booking] Voucher transaction created successfully');
          }
        }
      }

      if (deductionFailed) {
        await rollbackFinancialDeductions();
        await rollbackBookingsAndSeats();
        return res.status(409).json({ error: 'Voucher deduction failed due to concurrent modification or insufficient value' });
      }

      if (validatedTrainingFundAmount > 0) {
        const { data: updatedOrg, error: tfUpdateErr } = await supabase
          .from('organization')
          .update({ training_fund_balance: (org.training_fund_balance || 0) - validatedTrainingFundAmount })
          .eq('id', org.id)
          .gte('training_fund_balance', validatedTrainingFundAmount)
          .select('training_fund_balance')
          .single();

        if (tfUpdateErr || !updatedOrg) {
          console.error('[Complex Event Booking] Guarded training fund deduction failed');
          await rollbackFinancialDeductions();
          await rollbackBookingsAndSeats();
          return res.status(409).json({ error: 'Training fund deduction failed due to concurrent modification or insufficient balance' });
        } else {
          actualTrainingFundApplied = validatedTrainingFundAmount;

          if (!tenant?.id) {
            console.error('[Complex Event Booking] Refusing to write training_fund_transaction with NULL tenant_id', {
              eventId: event.id,
              orgId: org.id,
              firstBookingRef,
            });
            await rollbackFinancialDeductions();
            await rollbackBookingsAndSeats();
            return res.status(500).json({ error: 'Could not resolve tenant context for training fund transaction' });
          }
          const { error: tfTxError } = await supabase
            .from('training_fund_transaction')
            .insert({
              organization_id: org.id,
              type: 'booking_usage',
              amount: validatedTrainingFundAmount,
              balance_before: org.training_fund_balance,
              balance_after: updatedOrg.training_fund_balance,
              reason: `Complex event booking: ${event.title || 'Complex Event'} (${firstBookingRef})`,
              booking_id: bookings[0]?.id || null,
              created_by: member_id || null,
              created_date: new Date().toISOString(),
              tenant_id: tenant.id
            });

          if (tfTxError) {
            console.error('[Complex Event Booking] Failed to create training fund transaction:', tfTxError.message);
          } else {
            console.log('[Complex Event Booking] Training fund transaction created successfully');
          }
        }
      }

      if (confirmedPaymentMethod === 'account_balance') {
        const { data: updatedOrgBal, error: abErr } = await supabase
          .from('organization')
          .update({ account_balance: (org.account_balance || 0) - totalCostPounds })
          .eq('id', org.id)
          .gte('account_balance', totalCostPounds)
          .select('account_balance')
          .single();

        if (abErr || !updatedOrgBal) {
          console.error('[Complex Event Booking] Guarded account balance deduction failed');
          await rollbackFinancialDeductions();
          await rollbackBookingsAndSeats();
          return res.status(409).json({ error: 'Account balance deduction failed due to concurrent modification or insufficient balance' });
        }
        console.log(`[Complex Event Booking] Account balance decremented by £${totalCostPounds.toFixed(2)}, new balance: £${updatedOrgBal.account_balance.toFixed(2)}`);
      }
    }

    const actualVoucherApplied = voucherDeductions.reduce((sum, d) => sum + d.amount, 0);
    const actualTfApplied = actualTrainingFundApplied;

    if (bookings.length > 0) {
      const needsVoucherUpdate = actualVoucherApplied !== voucherAmountApplied;
      const needsTfUpdate = actualTfApplied !== validatedTrainingFundAmount;

      if (needsVoucherUpdate || needsTfUpdate) {
        const updateFields = {};
        if (needsVoucherUpdate) {
          updateFields.voucher_amount = actualVoucherApplied > 0 ? actualVoucherApplied / totalAttendees : 0;
          updateFields.voucher_id = voucherDeductions.length > 0 ? voucherDeductions[0].voucherId : null;
        }
        if (needsTfUpdate) {
          updateFields.training_fund_amount = actualTfApplied > 0 ? actualTfApplied / totalAttendees : 0;
        }
        await supabase
          .from('complex_event_booking')
          .update(updateFields)
          .eq('booking_group_reference', bookingGroupRef);
        console.log(`[Complex Event Booking] Reconciled booking records: voucher=£${actualVoucherApplied.toFixed(2)}, tf=£${actualTfApplied.toFixed(2)}`);
      }
    }

    const validatedRemainingBalance = Math.max(0, totalCostPounds - actualVoucherApplied - actualTfApplied);
    console.log(`[Complex Event Booking] Payment breakdown: totalCost=${totalCostPounds}, vouchers=${voucherAmountApplied}, trainingFund=${validatedTrainingFundAmount}, remaining=${validatedRemainingBalance}`);

    if (validatedRemainingBalance > 0) {
      const appTenantId = event.tenant_id || tenant.id;
      try {
        const { data: xeroSettings } = await supabase
          .from('system_settings')
          .select('setting_value')
          .eq('setting_key', 'xero_invoice_enabled')
          .eq('tenant_id', appTenantId)
          .maybeSingle();

        const xeroInvoiceEnabled = xeroSettings?.setting_value === 'true';

        if (xeroInvoiceEnabled) {
          console.log(`[Complex Event Booking] Xero invoice creation starting for £${validatedRemainingBalance.toFixed(2)}`);

          let invoiceContactInfo = null;
          if (org) {
            invoiceContactInfo = {
              name: org.name,
              email: org.invoicing_email || null,
              address: org.address || null,
              isOrganization: true
            };
          } else if (authenticatedMember) {
            const memberName = `${authenticatedMember.first_name || ''} ${authenticatedMember.last_name || ''}`.trim();
            invoiceContactInfo = {
              name: memberName || authenticatedMember.email,
              email: authenticatedMember.email,
              isOrganization: false
            };
          }

          if (invoiceContactInfo && invoiceContactInfo.name) {
            try {
              const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(appTenantId);

              if (accessToken && xeroTenantId) {
                const contactId = await findOrCreateXeroContact(accessToken, xeroTenantId, invoiceContactInfo);

                const { data: accountCodeSetting } = await supabase
                  .from('system_settings')
                  .select('setting_value')
                  .eq('setting_key', 'xero_sales_account_code')
                  .eq('tenant_id', appTenantId)
                  .maybeSingle();

                const systemDefaultAccountCode = accountCodeSetting?.setting_value || '200';
                const eventAccountCode = (event.xero_account_code || '').trim();
                const xeroAccountCode = eventAccountCode || systemDefaultAccountCode;

                const { data: invoiceStatusSetting } = await supabase
                  .from('system_settings')
                  .select('setting_value')
                  .eq('setting_key', 'xero_invoice_status')
                  .eq('tenant_id', appTenantId)
                  .maybeSingle();

                const xeroInvoiceStatus = invoiceStatusSetting?.setting_value || 'DRAFT';

                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + 30);
                const dueDateString = dueDate.toISOString().split('T')[0];

                const invoiceReference = poToFollow ? 'TBC' : (purchaseOrderNumber || 'TBC');

                const trackingCategory = event.internal_reference
                  ? [{ Name: 'Projects', Option: event.internal_reference }]
                  : undefined;

                const lineItems = resolvedItems.map(item => {
                  const qty = item.attendees.length;
                  const ticketName = item.serverTicket.name || 'Ticket';
                  const unitPrice = item.authoritativePrice;
                  const itemAttendees = item.attendees.map(a => {
                    const name = `${a.first_name || ''} ${a.last_name || ''}`.trim();
                    return name || a.email;
                  }).join(', ');

                  const descParts = [
                    `Event: ${event.title || 'Complex Event'}`,
                    `Ticket: ${ticketName}`,
                    `Attendees: ${itemAttendees}`
                  ];

                  const li = {
                    Description: descParts.join('\n'),
                    Quantity: qty,
                    UnitAmount: unitPrice,
                    AccountCode: xeroAccountCode
                  };

                  if (item.ticketClass?.vat_rate_key) {
                    li.TaxType = item.ticketClass.vat_rate_key;
                  }

                  if (trackingCategory) {
                    li.Tracking = trackingCategory;
                  }

                  return li;
                });

                if (actualVoucherApplied > 0) {
                  lineItems.push({
                    Description: 'Voucher discount',
                    Quantity: 1,
                    UnitAmount: -actualVoucherApplied,
                    AccountCode: xeroAccountCode
                  });
                }
                if (actualTfApplied > 0) {
                  lineItems.push({
                    Description: 'Training fund contribution',
                    Quantity: 1,
                    UnitAmount: -actualTfApplied,
                    AccountCode: xeroAccountCode
                  });
                }

                const invoicePayload = {
                  Type: 'ACCREC',
                  Contact: { ContactID: contactId },
                  DueDate: dueDateString,
                  LineItems: lineItems,
                  Reference: invoiceReference,
                  Status: xeroInvoiceStatus
                };

                console.log(`[Complex Event Booking] Sending invoice to Xero - Amount: £${validatedRemainingBalance.toFixed(2)}, Reference: ${invoiceReference}`);

                const invoiceResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'xero-tenant-id': xeroTenantId,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                  },
                  body: JSON.stringify({ Invoices: [invoicePayload] })
                });

                const responseText = await invoiceResponse.text();
                let invoiceData = null;
                try {
                  invoiceData = JSON.parse(responseText);
                } catch (parseError) {
                  console.error(`[Complex Event Booking] Failed to parse Xero response: ${responseText.substring(0, 200)}`);
                }

                if (invoiceData?.Invoices?.[0]) {
                  const invoice = invoiceData.Invoices[0];
                  console.log(`[Complex Event Booking] Xero invoice created: ${invoice.InvoiceNumber} (${invoice.InvoiceID})`);

                  const { error: updateError } = await supabase
                    .from('complex_event_booking')
                    .update({
                      xero_invoice_id: invoice.InvoiceID,
                      xero_invoice_number: invoice.InvoiceNumber
                    })
                    .eq('booking_group_reference', bookingGroupRef);

                  if (updateError) {
                    console.error(`[Complex Event Booking] Failed to update bookings with Xero data: ${updateError.message}`);
                  }

                  if (confirmedPaymentMethod === 'card' && stripe_payment_intent_id && invoice.InvoiceID && invoice.Status === 'AUTHORISED') {
                    try {
                      const { data: stripeBankCodeSetting } = await supabase
                        .from('system_settings')
                        .select('setting_value')
                        .eq('setting_key', 'xero_stripe_bank_account_code')
                        .eq('tenant_id', appTenantId)
                        .maybeSingle();

                      const stripeBankAccountCode = stripeBankCodeSetting?.setting_value;

                      if (stripeBankAccountCode) {
                        const accountsResponse = await fetch(`https://api.xero.com/api.xro/2.0/Accounts?where=Code=="${stripeBankAccountCode}"`, {
                          method: 'GET',
                          headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'xero-tenant-id': xeroTenantId,
                            'Accept': 'application/json'
                          }
                        });

                        const accountsData = await accountsResponse.json();
                        const bankAccount = accountsData?.Accounts?.[0];

                        if (bankAccount?.AccountID) {
                          const paymentPayload = {
                            Invoice: { InvoiceID: invoice.InvoiceID },
                            Account: { AccountID: bankAccount.AccountID },
                            Date: new Date().toISOString().split('T')[0],
                            Amount: validatedRemainingBalance,
                            Reference: `Stripe: ${stripe_payment_intent_id}`
                          };

                          const paymentResponse = await fetch('https://api.xero.com/api.xro/2.0/Payments', {
                            method: 'POST',
                            headers: {
                              'Authorization': `Bearer ${accessToken}`,
                              'xero-tenant-id': xeroTenantId,
                              'Content-Type': 'application/json',
                              'Accept': 'application/json'
                            },
                            body: JSON.stringify({ Payments: [paymentPayload] })
                          });

                          const paymentData = await paymentResponse.json();
                          if (paymentData?.Payments?.[0]?.PaymentID) {
                            console.log(`[Complex Event Booking] Xero payment recorded: ${paymentData.Payments[0].PaymentID}`);
                          } else {
                            console.error(`[Complex Event Booking] Failed to record Xero payment: ${JSON.stringify(paymentData).substring(0, 500)}`);
                          }
                        } else {
                          console.warn(`[Complex Event Booking] Bank account not found for code: ${stripeBankAccountCode}`);
                        }
                      } else {
                        console.log(`[Complex Event Booking] xero_stripe_bank_account_code not configured - payment not recorded`);
                      }
                    } catch (paymentError) {
                      console.error(`[Complex Event Booking] Xero payment recording error (non-fatal): ${paymentError.message}`);
                    }
                  }
                } else {
                  console.error(`[Complex Event Booking] Xero invoice creation failed: ${responseText.substring(0, 500)}`);
                }
              } else {
                console.error(`[Complex Event Booking] Missing Xero token or tenantId`);
              }
            } catch (xeroError) {
              console.error(`[Complex Event Booking] Xero invoice error (non-fatal): ${xeroError.message}`);
            }
          } else {
            console.log(`[Complex Event Booking] Cannot determine invoice contact - skipping`);
          }
        }
      } catch (xeroSettingsError) {
        console.error(`[Complex Event Booking] Xero settings check error (non-fatal): ${xeroSettingsError.message}`);
      }
    }

    const emailResults = [];
    console.log('[Complex Event Booking] Sending confirmation emails to attendees...');
    for (const booking of bookings) {
      const attendeeData = {
        email: booking.attendee_email,
        first_name: booking.attendee_first_name,
        last_name: booking.attendee_last_name
      };

      try {
        const results = await sendConfirmationEmailsFromTemplate(
          event_id,
          {
            ...booking,
            is_complex: true,
            ticketClassId: booking.ticket_class_id,
            ticketClassName: booking.ticket_class_name
          },
          attendeeData,
          null,
          {
            totalCost: totalCostPounds / totalAttendees,
            trainingFundAmount: actualTfApplied / totalAttendees,
            voucherAmount: actualVoucherApplied / totalAttendees,
            remainingBalance: validatedRemainingBalance / totalAttendees
          },
          tenant.id
        );
        emailResults.push(...results);
      } catch (emailErr) {
        console.error(`[Complex Event Booking] Confirmation email error for ${booking.attendee_email}: ${emailErr.message}`);
      }
    }
    if (emailResults.length > 0) {
      console.log(`[Complex Event Booking] Sent ${emailResults.filter(r => r.success).length}/${emailResults.length} confirmation emails`);
    }

    try {
      const { data: reminderEmails } = await supabase
        .from('event_email')
        .select('*')
        .eq('event_id', event_id)
        .eq('email_type', 'reminder')
        .eq('is_enabled', true);

      if (reminderEmails && reminderEmails.length > 0) {
        console.log(`[Complex Event Booking] Scheduling reminders using ${reminderEmails.length} reminder email(s)`);
        for (const booking of bookings) {
          await scheduleBookingComplexReminders(supabase, booking.id, event_id, booking.attendee_email, booking.ticket_class_id, reminderEmails);
        }
      }
    } catch (reminderErr) {
      console.error(`[Complex Event Booking] Reminder scheduling error (non-fatal): ${reminderErr.message}`);
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

async function scheduleBookingComplexReminders(supabase, bookingId, eventId, attendeeEmail, ticketClassId, reminderEmails) {
  try {
    const { data: sessions, error: sessionsError } = await supabase
      .from('complex_event_session')
      .select('id, title, start_time')
      .eq('event_id', eventId)
      .order('start_time', { ascending: true });

    if (sessionsError || !sessions || sessions.length === 0) {
      console.log('[Complex Event Booking] No sessions found for reminder scheduling');
      return;
    }

    const sessionIds = sessions.map(s => s.id);
    const { data: junctions } = await supabase
      .from('complex_event_session_track')
      .select('complex_event_session_id, complex_event_track_id')
      .in('complex_event_session_id', sessionIds);

    const sessionTrackMap = {};
    for (const j of (junctions || [])) {
      if (!sessionTrackMap[j.complex_event_session_id]) {
        sessionTrackMap[j.complex_event_session_id] = [];
      }
      sessionTrackMap[j.complex_event_session_id].push(j.complex_event_track_id);
    }

    let accessibleSessions = sessions;

    if (ticketClassId) {
      const { data: ticketClass } = await supabase
        .from('complex_event_ticket_class')
        .select('id, linked_track_ids, all_tracks')
        .eq('id', ticketClassId)
        .eq('complex_event_id', eventId)
        .maybeSingle();

      if (ticketClass && !ticketClass.all_tracks && ticketClass.linked_track_ids?.length > 0) {
        accessibleSessions = sessions.filter(s => {
          const trackIds = sessionTrackMap[s.id] || [];
          return trackIds.length === 0 ||
            trackIds.some(tid => ticketClass.linked_track_ids.includes(tid));
        });
      }
    }

    console.log(`[Complex Event Booking] ${accessibleSessions.length} accessible sessions for reminder scheduling (booking ${bookingId})`);

    const nowMs = Date.now();

    for (const email of reminderEmails) {
      if (isAbsoluteReminder(email)) {
        const scheduledTimeMs = calculateScheduledTimeMs(0, email);
        if (scheduledTimeMs == null || scheduledTimeMs <= nowMs) continue;
        const scheduledTimeISO = new Date(scheduledTimeMs).toISOString();

        const { data: existing } = await supabase
          .from('scheduled_email')
          .select('id')
          .eq('event_email_id', email.id)
          .eq('booking_id', bookingId)
          .is('session_id', null)
          .maybeSingle();

        if (existing) continue;

        const { error: insertError } = await supabase
          .from('scheduled_email')
          .insert({
            event_email_id: email.id,
            booking_id: bookingId,
            attendee_email: attendeeEmail,
            scheduled_send_time: scheduledTimeISO,
            session_id: null,
            status: 'pending'
          });

        if (insertError) {
          console.error(`[Complex Event Booking] Failed to schedule absolute reminder:`, insertError.message);
        }
        continue;
      }

      for (const session of accessibleSessions) {
        if (!session.start_time) continue;

        let startTimeStr = session.start_time;
        if (!startTimeStr.endsWith('Z') && !startTimeStr.includes('+') && !startTimeStr.includes('-', 10)) {
          startTimeStr = startTimeStr + 'Z';
        }
        const sessionStartMs = new Date(startTimeStr).getTime();
        if (isNaN(sessionStartMs)) continue;

        const scheduledTimeMs = calculateScheduledTimeMs(sessionStartMs, email);
        if (!scheduledTimeMs) continue;

        if (scheduledTimeMs <= nowMs) continue;

        const scheduledTimeISO = new Date(scheduledTimeMs).toISOString();

        const { data: existing } = await supabase
          .from('scheduled_email')
          .select('id')
          .eq('event_email_id', email.id)
          .eq('booking_id', bookingId)
          .eq('session_id', session.id)
          .maybeSingle();

        if (existing) continue;

        const { error: insertError } = await supabase
          .from('scheduled_email')
          .insert({
            event_email_id: email.id,
            booking_id: bookingId,
            attendee_email: attendeeEmail,
            scheduled_send_time: scheduledTimeISO,
            session_id: session.id,
            status: 'pending'
          });

        if (insertError) {
          console.error(`[Complex Event Booking] Failed to schedule reminder for session ${session.title}:`, insertError.message);
        }
      }
    }
  } catch (err) {
    console.error('[Complex Event Booking] Reminder scheduling error:', err.message);
  }
}

function getHoursFromTimingType(timingType, customHours) {
  switch (timingType) {
    case '7_days_before': return 7 * 24;
    case '3_days_before': return 3 * 24;
    case '1_day_before': return 24;
    case '12_hours_before': return 12;
    case '6_hours_before': return 6;
    case '1_hour_before': return 1;
    case '30_minutes_before': return 0.5;
    case 'custom': return customHours || 24;
    default: return 24;
  }
}

function isAbsoluteReminder(email) {
  return (
    email &&
    email.timing_type === 'custom' &&
    email.custom_unit === 'specific_datetime' &&
    !!email.custom_send_at
  );
}

function calculateScheduledTimeMs(referenceMs, email) {
  const { timing_type, custom_hours_before, custom_unit, custom_send_at } = email;

  if (timing_type === 'custom' && custom_unit === 'specific_datetime') {
    if (custom_send_at) {
      return new Date(custom_send_at).getTime();
    }
    return null;
  }

  let hoursBeforeEvent;
  if (timing_type === 'custom') {
    const value = custom_hours_before || 24;
    switch (custom_unit) {
      case 'days': hoursBeforeEvent = value * 24; break;
      case 'minutes': hoursBeforeEvent = value / 60; break;
      case 'hours':
      default: hoursBeforeEvent = value; break;
    }
  } else {
    hoursBeforeEvent = getHoursFromTimingType(timing_type, custom_hours_before);
  }

  return referenceMs - (hoursBeforeEvent * 60 * 60 * 1000);
}
