import { createClient } from '@supabase/supabase-js';
import { replayPublicTicketBooking, compensatePublicTicketCapacity } from '../_lib/publicTicketMemberRecovery.js';
import { assertPublicTicketPurchaser } from '../_lib/publicTicketEmail.js';
import { preparePublicTicketPurchase, bindPublicTicketPayment, completePublicTicketMembers, assertPublicTicketPaymentEvidence, loadPublicTicketPurchase } from '../_lib/publicTicketMemberPurchase.js';
import { PUBLIC_INVOICE_PO, validatePublicInvoicePo, requirePublicInvoicePoBalance } from '../_lib/publicInvoicePo.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { scheduleComplexEventReminders } from '../_lib/complexEventReminders.js';
import { getSessionMember } from '../_lib/session.js';
import { getStripeCredentials } from '../_lib/stripeCredentials.js';
import { sanitizeOptionSelections, isAttendeeOptionsCollectionEnabled, EMPTY_OPTION_SELECTIONS } from '../_lib/eventOptionSelections.js';
import { fetchMemberJobTitlesByEmail, resolveStoredJobTitle } from '../_lib/attendeeJobTitleEnrichment.js';
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
  getMemberGroupIdsForMember,
  isActiveMemberOfGroup
} from '../_lib/ticketAccess.js';
import { enqueueCheckoutEventInvoice, eventInvoiceContact, complexEventInvoiceLines } from '../_lib/eventInvoiceProducer.js';
import { getAllowVoucherUseAfterExpiry, isVoucherUsableForEventDate } from '../_lib/voucherExpiryPolicy.js';
import { orderVoucherIdsForRedemption } from '../_lib/voucherOrdering.js';
import { sendConfirmationEmailsFromTemplate } from '../_lib/eventConfirmationEmail.js';
import {
  claimAllocationInvitation,
  resolveAllocationInvitation,
} from '../_lib/allocationInvitation.js';
import {
  paymentIntentMatchesAllocation,
  refundBoundAllocationPayment,
  runAuthorizedCardCompensation,
} from '../_lib/allocationPaymentBinding.js';
import { loadEventPaymentPolicy, assertEventPaymentMethodsAllowed } from '../_lib/eventPaymentPolicy.js';
import { assertRequestedTicketsReleased, loadComplexReleaseTickets } from '../_lib/ticketReleaseAccess.js';
import { compensateRejectedEventCreditPayment } from '../_lib/eventPaymentPolicyCompensation.js';

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
      event_id: requestedEventId,
      attendees: legacyAttendees,
      ticket_class_id: legacyTicketClassId,
      payment_method,
      purchaser_info: purchaserInfo,
      stripe_payment_intent_id,
      discount_code: legacyDiscountCode,
      items,
      selected_voucher_ids,
      voucher_order_manual: voucherOrderManual,
      training_fund_amount: requestedTrainingFundAmount,
      purchase_order_number: purchaseOrderNumber,
      po_to_follow: poToFollow,
      third_party_consent: thirdPartyConsent,
      allocation_invitation_token: allocationInvitationToken
    } = req.body;
    let event_id = requestedEventId;
    let allocationContext = null;
    if (allocationInvitationToken) {
      allocationContext = await resolveAllocationInvitation(supabase, allocationInvitationToken);
      if (allocationContext.tenantId !== tenant.id || allocationContext.eventKind !== 'complex') {
        return res.status(404).json({ error: 'Invalid allocation invitation' });
      }
      if (requestedEventId && requestedEventId !== allocationContext.eventId) {
        return res.status(400).json({ error: 'Event is fixed by the allocation invitation' });
      }
      event_id = allocationContext.eventId;
    }

    let authenticatedMember = null;
    let purchaserSessionError = null;
    try {
      const sessionMember = await getSessionMember(req);
      if (sessionMember) {
        const memberTenantId = sessionMember.organization?.tenant_id || sessionMember.tenant_id;
        if (memberTenantId && memberTenantId === tenant.id) {
          authenticatedMember = sessionMember;
        }
      }
    } catch (e) { purchaserSessionError = e; }
    const member_id = authenticatedMember?.id || null;
    const organization_id = allocationContext?.organizationId
      || authenticatedMember?.organization_id || null;

    if (!event_id) return res.status(400).json({ error: 'event_id is required' });

    const isMultiTicket = Array.isArray(items) && items.length > 0;

    const normalizedItems = isMultiTicket
      ? items
      : [{
          ticket_class_id: legacyTicketClassId,
          attendees: legacyAttendees,
          discount_code: legacyDiscountCode
        }];
    if (allocationContext) {
      const coveredItems = normalizedItems.filter(
        (item) => String(item.ticket_class_id) === String(allocationContext.ticketTypeId),
      );
      if (coveredItems.length !== 1 || coveredItems[0].attendees?.length !== 1) {
        return res.status(400).json({
          error: 'Allocation invitation covers exactly one delegate on its fixed ticket type',
        });
      }
      const delegateEmail = String(coveredItems[0].attendees[0]?.email || '').trim().toLowerCase();
      if (delegateEmail !== allocationContext.delegateEmail) {
        return res.status(400).json({ error: 'Delegate email is fixed by the allocation invitation' });
      }
    }

    for (const item of normalizedItems) {
      if (!item.attendees || !Array.isArray(item.attendees) || item.attendees.length === 0) {
        return res.status(400).json({ error: 'At least one attendee is required per ticket type' });
      }
    }

    const { data: event, error: eventError } = await supabase
      .from('complex_event')
      .select('id, title, status, event_state, tenant_id, member_group_id, available_seats, internal_reference, xero_account_code, pricing_config, dietary_options, allergy_options, accessibility_options, start_date, allow_public_invoice_po')
      .eq('id', event_id)
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc'])
      .single();

    if (eventError || !event) return res.status(404).json({ error: 'Event not found' });

    let allTicketClasses;
    try { allTicketClasses = await loadComplexReleaseTickets(supabase, event); }
    catch (error) { return res.status(503).json({ error: error.message }); }
    const provisioningItems = normalizedItems.map(item => ({
      ticket: getTicketClassFromConfig(allTicketClasses, item.ticket_class_id) || { id: item.ticket_class_id }, attendees: item.attendees,
    }));
    const previousPublicPurchase = req.body.purchase_request_id && payment_method !== PUBLIC_INVOICE_PO
      ? await loadPublicTicketPurchase(supabase, {
        tenantId: tenant.id, eventId: event.id, eventKind: 'complex', requestId: req.body.purchase_request_id,
        allowMissingSchema: !provisioningItems.some(item => item.ticket?.create_member_records === true),
      }) : null;
    let publicTicketPurchase = null;
    if ((previousPublicPurchase || provisioningItems.some(item => item.ticket?.create_member_records === true)) && payment_method !== PUBLIC_INVOICE_PO) {
      if (selected_voucher_ids?.length || Number(requestedTrainingFundAmount) || allocationContext
          || !['card', 'free'].includes(payment_method)) {
        return res.status(400).json({ error: 'Public ticket member creation requires a guest card or free checkout without account credits.' });
      }
      publicTicketPurchase = await preparePublicTicketPurchase({
        db: supabase, tenantId: tenant.id, eventId: event.id, eventKind: 'complex',
        requestId: req.body.purchase_request_id, purchaser: purchaserInfo,
        items: provisioningItems, authenticatedMember: await getSessionMember(req), resumeExisting: true,
      });
      const replay = await replayPublicTicketBooking(supabase, publicTicketPurchase);
      if (replay) return res.status(replay.success ? 200 : 409).json(replay);
      if (payment_method === 'free' && publicTicketPurchase.stripe_payment_intent_id) {
        return res.status(409).json({ error: 'This checkout requires its original verified payment. Do not pay again.' });
      }
    } else if (payment_method !== PUBLIC_INVOICE_PO
        && provisioningItems.some(item => item.ticket?.visibility_mode === 'public_only')) {
      await assertPublicTicketPurchaser({
        db: supabase, tenantId: tenant.id,
        purchaserEmail: purchaserInfo?.email || normalizedItems[0]?.attendees?.[0]?.email,
        authenticatedMember: await getSessionMember(req),
      });
    }
    if (payment_method === 'card' && stripe_payment_intent_id && !publicTicketPurchase) {
      const { data: existing, error } = await supabase.from('complex_event_booking')
        .select('id').eq('tenant_id', tenant.id).eq('event_id', event.id)
        .eq('stripe_payment_intent_id', stripe_payment_intent_id).limit(1);
      if (error) return res.status(503).json({ error: 'Unable to verify existing payment bookings' });
      if (existing?.length) return res.status(409).json({ error: 'This payment has already been used for a booking' });
    }
    let ticketReleaseError = null;
    try {
      assertRequestedTicketsReleased({
        event, tickets: allTicketClasses,
        ticketIds: normalizedItems.map(item => item?.ticket_class_id),
        allocationContext, eventKind: 'complex',
      });
    } catch (error) {
      ticketReleaseError = error;
    }

    const voucherPaymentRequested = payment_method === 'voucher'
      || (Array.isArray(selected_voucher_ids) && selected_voucher_ids.length > 0);
    const trainingFundPaymentRequested = payment_method === 'training_fund'
      || Number(requestedTrainingFundAmount) > 0;
    if (ticketReleaseError || voucherPaymentRequested || trainingFundPaymentRequested) {
      try {
        if (ticketReleaseError) throw ticketReleaseError;
        const paymentPolicy = await loadEventPaymentPolicy(supabase, tenant.id);
        assertEventPaymentMethodsAllowed(paymentPolicy, {
          voucherRequested: voucherPaymentRequested,
          trainingFundRequested: trainingFundPaymentRequested,
        });
      } catch (policyError) {
        if (payment_method === 'card' && stripe_payment_intent_id) {
          const { data: existingPaidBooking } = await supabase
            .from('complex_event_booking')
            .select('id')
            .eq('tenant_id', tenant.id)
            .eq('stripe_payment_intent_id', stripe_payment_intent_id)
            .limit(1);
          if (!existingPaidBooking?.length) {
            try {
              const creds = await getStripeCredentials(tenant.id, 'events');
              if (!creds?.secret_key) throw new Error('Payment processing not configured');
              const retrieveResponse = await fetch(
                `https://api.stripe.com/v1/payment_intents/${stripe_payment_intent_id}`,
                { headers: { Authorization: `Bearer ${creds.secret_key}` } },
              );
              if (!retrieveResponse.ok) throw new Error('Failed to verify card payment');
              const paymentIntent = await retrieveResponse.json();
              const providerAction = async (path, idempotencyKey, body = null) => {
                const response = await fetch(`https://api.stripe.com/v1/${path}`, {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${creds.secret_key}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Idempotency-Key': idempotencyKey,
                  },
                  ...(body ? { body: new URLSearchParams(body) } : {}),
                });
                if (!response.ok) throw new Error(`Stripe compensation failed (${response.status})`);
              };
              const compensation = await compensateRejectedEventCreditPayment({
                paymentIntent,
                expectedIntentId: stripe_payment_intent_id,
                tenantId: tenant.id,
                eventId: event_id,
                purchaserEmail: authenticatedMember?.email || purchaserInfo?.email || normalizedItems[0]?.attendees?.[0]?.email,
                allocationContext,
                expectedCreditSnapshot: ticketReleaseError ? null : {
                  voucherIds: selected_voucher_ids,
                  voucherOrderManual,
                  trainingFundAmount: requestedTrainingFundAmount,
                },
                refundSucceeded: () => providerAction(
                  'refunds',
                  `event-credit-policy:${tenant.id}:${stripe_payment_intent_id}`,
                  { payment_intent: stripe_payment_intent_id, reason: 'requested_by_customer' },
                ),
                cancelAuthorization: () => providerAction(
                  `payment_intents/${stripe_payment_intent_id}/cancel`,
                  `event-credit-policy-cancel:${tenant.id}:${stripe_payment_intent_id}`,
                ),
              });
              if (!compensation.ok) {
                return res.status(502).json({
                  error: `${policyError.message}. The card payment could not be automatically reversed. Please contact support with reference: ${stripe_payment_intent_id}`,
                  refund_failed: true,
                  stripe_payment_intent_id,
                });
              }
              if (!compensation.compensated) {
                return res.status(policyError.statusCode || 403).json({ error: policyError.message });
              }
              return res.status(policyError.statusCode || 403).json({
                error: `${policyError.message}. Your card payment has been automatically ${compensation.action === 'cancelled' ? 'cancelled' : 'refunded'}.`,
                refunded: compensation.action === 'refunded',
                payment_cancelled: compensation.action === 'cancelled',
              });
            } catch (compensationError) {
              return res.status(502).json({
                error: `${policyError.message}. The card payment could not be automatically reversed. Please contact support with reference: ${stripe_payment_intent_id}`,
                refund_failed: true,
                stripe_payment_intent_id,
              });
            }
          }
        }
        return res.status(policyError.statusCode || 503).json({ error: policyError.message });
      }
    }

    let purchaserContext = null;
    if (payment_method === PUBLIC_INVOICE_PO) {
      try {
        if (purchaserSessionError) throw new Error('Unable to verify purchaser session');
        purchaserContext = await validatePublicInvoicePo({
          client: supabase, event, authenticatedMember, purchaserInfo,
          stripePaymentIntentId: stripe_payment_intent_id, voucherIds: selected_voucher_ids,
          trainingFundAmount: requestedTrainingFundAmount, accountAmount: req.body.account_amount,
          allocationContext, purchaseOrderNumber,
        });
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }

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

    // Task #1519: Group events (member_group_id set) are SELF-ONLY. A caller may
    // only register themselves — no colleagues, external attendees, or buy-N.
    // Reject any booking that attempts to add extra/other attendees.
    if (event.member_group_id) {
      // Task #3508: only ACTIVE members of the linked member group may book a
      // group event. Everyone can view the event, but booking requires
      // membership of the group.
      if (!authenticatedMember) {
        return res.status(401).json({ error: 'You must be logged in as a member of this event\'s group to book' });
      }
      const isGroupMember = await isActiveMemberOfGroup(supabase, authenticatedMember.id, event.member_group_id);
      if (!isGroupMember) {
        return res.status(403).json({ error: 'Only members of this event\'s group can book this event. Join the group to attend.' });
      }

      const groupEventAttendees = [];
      for (const item of normalizedItems) {
        for (const attendee of (item.attendees || [])) {
          groupEventAttendees.push(attendee);
        }
      }
      if (groupEventAttendees.length !== 1) {
        return res.status(403).json({ error: 'Group events only allow self-registration' });
      }
      if (authenticatedMember) {
        const callerEmail = String(authenticatedMember.email || '').trim().toLowerCase();
        const attendeeEmail = String(groupEventAttendees[0]?.email || '').trim().toLowerCase();
        if (!callerEmail || attendeeEmail !== callerEmail) {
          return res.status(403).json({ error: 'Group events only allow self-registration' });
        }
      }
    }

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
      const allocationCovered = !!allocationContext
        && String(item.ticket_class_id) === String(allocationContext.ticketTypeId);
      let authoritativePrice = allocationCovered || ticketClass?.is_free ? 0 : serverTicket.price;
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
        allocationCovered,
        attendees: item.attendees
      });
    }

    const isFree = grandTotalMinor === 0;
    if (publicTicketPurchase && isFree && payment_method === 'card') {
      return res.status(400).json({ error: 'A zero-cost purchase must use confirmed free booking, not a card payment.' });
    }
    const totalCostPounds = grandTotalMinor / 100;
    if (payment_method === PUBLIC_INVOICE_PO) {
      try { requirePublicInvoicePoBalance(totalCostPounds); }
      catch (error) { return res.status(400).json({ error: error.message }); }
    }

    let paymentStatus = 'free';
    let confirmedPaymentMethod = 'free';
    // Captured during card verification so sold-out paths can auto-refund
    // (mirrors the standard-event guard's auto-refund). Task #1760.
    let stripeSecretKeyForRefund = null;
    let invoicePaymentEvidence = null;
    let allocationPaymentBindingVerified = false;
    let cardPaymentAuthorizedForCompensation = false;

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
      const validPaidMethods = ['card', 'account', 'account_balance', 'training_fund', 'voucher', 'invoice', PUBLIC_INVOICE_PO];
      if (!payment_method || !validPaidMethods.includes(payment_method)) {
        return res.status(400).json({
          error: `Invalid payment method. Supported methods: ${validPaidMethods.join(', ')}`
        });
      }

      if (payment_method === PUBLIC_INVOICE_PO) {
        paymentStatus = 'pending';
        confirmedPaymentMethod = PUBLIC_INVOICE_PO;
      } else if (payment_method === 'card') {
        if (!stripe_payment_intent_id) {
          return res.status(400).json({ error: 'stripe_payment_intent_id is required for card payments' });
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
        stripeSecretKeyForRefund = stripeSecretKey;

        try {
          const stripeResponse = await fetch(`https://api.stripe.com/v1/payment_intents/${stripe_payment_intent_id}?expand[]=latest_charge`, {
            headers: { 'Authorization': `Bearer ${stripeSecretKey}` }
          });
          const paymentIntent = await stripeResponse.json();
          const refundInvalidIntent = async () => {
            if (paymentIntent.status !== 'succeeded') return;
            await refundBoundAllocationPayment(paymentIntent, allocationContext, async () => {
              await fetch('https://api.stripe.com/v1/refunds', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${stripeSecretKey}`,
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Idempotency-Key': `complex-booking-invalid:${stripe_payment_intent_id}`,
                },
                body: new URLSearchParams({ payment_intent: stripe_payment_intent_id, reason: 'requested_by_customer' }),
              });
            });
          };

          if (paymentIntent.status !== 'succeeded') {
            return res.status(400).json({ error: 'Payment has not been completed' });
          }

          if (allocationContext) {
            const allocationMetadataMatches = paymentIntentMatchesAllocation(paymentIntent, allocationContext);
            if (!allocationMetadataMatches) {
              return res.status(400).json({ error: 'Payment intent does not match this allocation invitation' });
            }
            allocationPaymentBindingVerified = true;
          }

          const maxReasonableAmount = grandTotalMinor + 100;
          if (paymentIntent.amount > maxReasonableAmount) {
            console.error(`[Complex Event Booking] Stripe amount exceeds expected maximum: intent=${paymentIntent.amount}, max=${maxReasonableAmount}`);
            await refundInvalidIntent();
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
            await refundInvalidIntent();
            return res.status(400).json({ error: 'Payment amount is insufficient for this booking' });
          }

          const firstCurrency = resolvedItems[0]?.ticketCurrency || 'gbp';
          const intentCurrency = (paymentIntent.currency || '').toLowerCase();
          if (intentCurrency !== firstCurrency.toLowerCase()) {
            await refundInvalidIntent();
            return res.status(400).json({ error: 'Payment currency does not match' });
          }

          const piEventId = paymentIntent.metadata?.event_id;
          if (!piEventId || piEventId !== event_id) {
            await refundInvalidIntent();
            return res.status(400).json({ error: 'Payment intent does not match this event' });
          }

          if (!isMultiTicket) {
            const piTicketClassId = paymentIntent.metadata?.ticket_class_id;
            if (piTicketClassId && piTicketClassId !== legacyTicketClassId) {
              await refundInvalidIntent();
              return res.status(400).json({ error: 'Payment intent does not match this ticket class' });
            }
          }
          // Set only after every ordinary authoritative PI validation above.
          // Allocation checkouts can reach here only after their stronger
          // invitation binding was also verified.
          cardPaymentAuthorizedForCompensation = !allocationContext
            || allocationPaymentBindingVerified;
          if (publicTicketPurchase) {
            assertPublicTicketPaymentEvidence(paymentIntent, publicTicketPurchase, tenant.id, event.id);
            await bindPublicTicketPayment(supabase, publicTicketPurchase.id, tenant.id, paymentIntent.id);
          }
          invoicePaymentEvidence = paymentIntent;
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

        const allowVoucherAfterExpiry = await getAllowVoucherUseAfterExpiry(supabase, event.tenant_id || tenant.id);

        // Event start for the expiry policy: stored start_date, falling back to
        // the earliest session start when start_date hasn't been computed yet.
        let voucherPolicyEventStart = event.start_date || null;
        if (!allowVoucherAfterExpiry && !voucherPolicyEventStart) {
          const { data: earliestSession } = await supabase
            .from('complex_event_session')
            .select('start_time')
            .eq('complex_event_id', event.id)
            .not('start_time', 'is', null)
            .order('start_time', { ascending: true })
            .limit(1)
            .maybeSingle();
          voucherPolicyEventStart = earliestSession?.start_time || null;
        }

        // First-expiry-first-used: by default, apply vouchers in earliest-
        // expiry order (then earliest allocation date). If the caller
        // explicitly requested a manual order (voucher_order_manual),
        // preserve the client-sent order and record the override in the
        // transaction notes/audit trail. Shared logic: api/_lib/voucherOrdering.js.
        let orderedVoucherIds = [...voucherIds];
        let voucherOrderOverrideNote = null;
        {
          let byId = null;
          if (voucherOrderManual !== true && voucherIds.length > 1) {
            const { data: selVouchers, error: selErr } = await supabase
              .from('voucher')
              .select('id, expires_at, issued_at')
              .in('id', voucherIds)
              .eq('organization_id', org.id);
            if (!selErr && Array.isArray(selVouchers) && selVouchers.length > 0) {
              byId = {};
              selVouchers.forEach(v => { byId[v.id] = v; });
            }
          }
          const ordered = orderVoucherIdsForRedemption(voucherIds, byId, voucherOrderManual === true);
          orderedVoucherIds = ordered.orderedIds;
          voucherOrderOverrideNote = ordered.overrideNote;
        }

        for (const voucherId of orderedVoucherIds) {
          const { data: voucher } = await supabase
            .from('voucher')
            .select('*')
            .eq('id', voucherId)
            .eq('organization_id', org.id)
            .eq('status', 'active')
            .single();

          if (voucher && !isVoucherUsableForEventDate(voucher, voucherPolicyEventStart, allowVoucherAfterExpiry)) {
            return res.status(400).json({
              error: 'One or more selected vouchers expire before the event takes place and cannot be used for this booking.'
            });
          }

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

    // Auto-refund any card payment when we have to bail out on a sold-out race
    // (mirrors the standard-event guard's behaviour). Task #1760.
    const refundCardPayment = async () => {
      if (confirmedPaymentMethod !== 'card' || !stripe_payment_intent_id || !stripeSecretKeyForRefund
        || !cardPaymentAuthorizedForCompensation) {
        return { refunded: false };
      }
      return runAuthorizedCardCompensation(cardPaymentAuthorizedForCompensation, async () => {
       try {
        const resp = await fetch('https://api.stripe.com/v1/refunds', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${stripeSecretKeyForRefund}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Idempotency-Key': `complex-booking-compensation:${stripe_payment_intent_id}`,
          },
          body: new URLSearchParams({
            payment_intent: stripe_payment_intent_id,
            reason: 'requested_by_customer'
          })
        });
        const data = await resp.json();
        if (!resp.ok) {
          console.error('[Complex Event Booking] Auto-refund failed:', data?.error?.message || resp.status);
          return { refunded: false };
        }
        console.log('[Complex Event Booking] Auto-refunded payment intent', stripe_payment_intent_id);
        return { refunded: true };
       } catch (e) {
        console.error('[Complex Event Booking] Auto-refund exception:', e.message);
        return { refunded: false };
       }
      });
    };

    // Count-based ticket capacity PRE-CHECK (Task #1760). available_count on a
    // complex_event_ticket_class is a FIXED maximum that is never mutated;
    // availability is derived from the count of status='confirmed'
    // complex_event_booking rows. The guard atomically confirms there is room
    // before we decrement event seats or insert anything. We run it BEFORE the
    // event-seat decrement so a sold-out class needs no seat restore here.
    for (const [tcId, count] of Object.entries(publicTicketPurchase ? {} : ticketClassCounts)) {
      const tc = allTicketClasses.find(t => String(t.id) === String(tcId));
      if (!tc || tc.is_unlimited_tickets || tc.available_count === null || tc.available_count === undefined) continue;
      try {
        const { data: capCheck, error: capError } = await supabase.rpc('check_complex_event_ticket_capacity', {
          p_event_id: event_id,
          p_ticket_class_id: String(tcId),
          p_requested: count,
          p_booking_ids: null
        });
        if (capError) {
          console.error('[Complex Event Booking] Capacity pre-check RPC error:', capError.message);
        } else if (capCheck && capCheck.ok === false) {
          console.warn(`[Complex Event Booking] Ticket class sold out at pre-check: '${tc.name}'`, capCheck);
          const { refunded } = await refundCardPayment();
          return res.status(409).json({
            error: refunded
              ? `Sorry, "${tc.name}" tickets have just sold out. Your payment has been automatically refunded.`
              : `Not enough seats available for ticket class '${tc.name}'`,
            sold_out: true,
            refunded
          });
        }
      } catch (capErr) {
        console.error('[Complex Event Booking] Capacity pre-check exception:', capErr.message);
      }
    }

    if (!publicTicketPurchase && event.available_seats !== null && event.available_seats !== undefined) {
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

    // Ticket-class capacity is NOT decremented in stored columns anymore
    // (count-based, Task #1760). Only the event-level available_seats counter is
    // still maintained as a stored value; the post-verify guard below enforces
    // per-ticket-class limits atomically against confirmed-booking counts.
    let seatsDecrementedForEvent = !publicTicketPurchase && event.available_seats !== null && event.available_seats !== undefined;

    let bookingGroupRef = generateBookingReference();
    const bookings = [];
    const publicTicketBookingRows = [];
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
          seatsDecrementedForEvent = false;
        }
      }
    };

    // Tenant toggle: when dietary/accessibility collection is disabled,
    // never persist submitted selections (defense in depth).
    const collectOptionsEnabled = await isAttendeeOptionsCollectionEnabled(supabase, tenant.id);

    // Task #3310: attendees who are members in their own right but did not
    // enter a job title get their own member-profile title stored at booking
    // time. Explicitly entered titles always win; non-members stay blank.
    const memberJobTitlesByEmail = await fetchMemberJobTitlesByEmail(
      supabase,
      tenant.id,
      resolvedItems.flatMap((it) => it.attendees.filter((a) => !(a.job_title || '').trim()).map((a) => a.email))
    );

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
          attendee_job_title: resolveStoredJobTitle(attendee.job_title, email, memberJobTitlesByEmail),
          member_id: member_id || null,
          organization_id: organization_id || null,
          ticket_class_id: item.ticket_class_id || null,
          ticket_class_name: item.serverTicket.name || null,
          ticket_price: item.authoritativePrice,
          payment_method: confirmedPaymentMethod,
          ...(purchaserContext ? { purchaser_context: purchaserContext } : {}),
          payment_status: paymentStatus,
          stripe_payment_intent_id: publicTicketPurchase || isFirstAttendeeOverall ? (stripe_payment_intent_id || null) : null,
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
          third_party_consent: (event.pricing_config?.collectThirdPartyConsent === true && typeof thirdPartyConsent === 'boolean') ? thirdPartyConsent : null,
          ...(collectOptionsEnabled ? sanitizeOptionSelections(attendee, event) : EMPTY_OPTION_SELECTIONS)
        };

        if (publicTicketPurchase) {
          publicTicketBookingRows.push(bookingData);
          isFirstAttendeeOverall = false;
          continue;
        }
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
    let actualAccountBalanceApplied = 0;

    const rollbackBookingsAndSeats = async () => {
      await restoreSeats();
      for (const booking of bookings) {
        if (!allocationContext || String(booking.ticket_class_id) !== String(allocationContext.ticketTypeId)) continue;
        const { error: allocationRollbackError } = await supabase.rpc(
          'unreconcile_sales_commercial_booking',
          {
            p_tenant_id: tenant.id,
            p_booking_kind: 'complex',
            p_booking_id: booking.id,
            p_idempotency_key: `booking-rollback:${booking.id}`,
            p_actor_kind: 'system',
            p_actor_id: booking.id,
          },
        );
        if (allocationRollbackError) {
          throw new Error(`Failed to return allocated place: ${allocationRollbackError.message}`);
        }
      }
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

    if (publicTicketPurchase) {
      const { data: batch, error: batchError } = await supabase.rpc('insert_public_ticket_booking_batch', {
        p_purchase_id: publicTicketPurchase.id, p_rows: publicTicketBookingRows,
      });
      if (batchError || !Array.isArray(batch) || batch.length !== totalAttendees) {
        if (batch?.error === 'capacity_unavailable' || publicTicketPurchase.last_error_code === 'capacity_refund_pending') {
          const compensation = await compensatePublicTicketCapacity(supabase, {
            ...publicTicketPurchase, tenant_id: tenant.id, event_id: event.id,
            stripe_payment_intent_id,
          });
          return res.status(409).json({ success: false, ...compensation,
            error: compensation.refunded ? 'These tickets are no longer available. Your payment has been refunded.'
              : 'These tickets are no longer available. Any captured payment is queued for automatic refund. Do not pay again.',
            purchase_reference: publicTicketPurchase.id });
        }
        return res.status(503).json({ error: 'Unable to complete this booking batch. Retry this checkout without making another payment.', purchase_reference: publicTicketPurchase.id });
      }
      bookings.push(...batch);
      bookingGroupRef = batch[0].booking_group_reference || batch[0].booking_reference;
    }
    // Count-based ticket capacity POST-VERIFY (Task #1760). Our rows are now
    // inserted (status='confirmed'); re-rank them under the same per-class
    // advisory lock. If a class is over its maximum, the guard DELETES the
    // losing rows for us. We then roll back the remainder of the group, restore
    // event seats, and auto-refund any card payment. Runs BEFORE any financial
    // deduction so there is nothing financial to unwind on a sold-out race.
    const bookingIdsByClass = {};
    for (const b of bookings) {
      if (!b.ticket_class_id) continue;
      const key = String(b.ticket_class_id);
      (bookingIdsByClass[key] = bookingIdsByClass[key] || []).push(b.id);
    }
    let capacityExceeded = false;
    let exceededTicketName = null;
    for (const [tcId, ids] of Object.entries(publicTicketPurchase ? {} : bookingIdsByClass)) {
      const tc = allTicketClasses.find(t => String(t.id) === String(tcId));
      if (!tc || tc.is_unlimited_tickets || tc.available_count === null || tc.available_count === undefined) continue;
      try {
        const { data: capVerify, error: capVerifyError } = await supabase.rpc('check_complex_event_ticket_capacity', {
          p_event_id: event_id,
          p_ticket_class_id: String(tcId),
          p_requested: ids.length,
          p_booking_ids: ids
        });
        if (capVerifyError) {
          console.error('[Complex Event Booking] Capacity post-verify RPC error:', capVerifyError.message);
        } else if (capVerify && capVerify.ok === false) {
          capacityExceeded = true;
          exceededTicketName = tc.name;
          console.warn(`[Complex Event Booking] Capacity exceeded at post-verify for '${tc.name}'; losing rows removed by guard`, capVerify);
          break;
        }
      } catch (capErr) {
        console.error('[Complex Event Booking] Capacity post-verify exception:', capErr.message);
      }
    }
    if (capacityExceeded) {
      await rollbackBookingsAndSeats();
      const { refunded } = await refundCardPayment();
      return res.status(409).json({
        error: refunded
          ? `Sorry, "${exceededTicketName}" tickets have just sold out. Your payment has been automatically refunded.`
          : `Sorry, "${exceededTicketName}" tickets have just sold out.`,
        sold_out: true,
        refunded
      });
    }

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
      if (actualAccountBalanceApplied > 0 && org) {
        const { error: accountRestoreError } = await supabase
          .from('organization')
          .update({ account_balance: (org.account_balance || 0) })
          .eq('id', org.id);
        if (accountRestoreError) throw new Error(`Account balance rollback failed: ${accountRestoreError.message}`);
        actualAccountBalanceApplied = 0;
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
              notes: voucherOrderOverrideNote,
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
        actualAccountBalanceApplied = totalCostPounds;
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

    // Claims happen after capacity and reversible internal deductions, but
    // before invoices, confirmation messages, or reminder jobs.
    if (allocationContext) {
      const coveredBooking = bookings.find((booking) => String(booking.ticket_class_id) === String(allocationContext.ticketTypeId));
      try {
        await claimAllocationInvitation(supabase, allocationInvitationToken, 'complex', coveredBooking?.id);
      } catch (claimError) {
        try {
          await rollbackFinancialDeductions();
          await rollbackBookingsAndSeats();
          await refundCardPayment();
        } catch (compensationError) {
          console.error('[Complex Event Booking] Allocation claim compensation failed:', compensationError.message);
          return res.status(500).json({ error: `Allocation claim failed and compensation requires attention: ${compensationError.message}` });
        }
        return res.status(claimError.status || 409).json({ error: claimError.message });
      }
    }

    const memberCreation = publicTicketPurchase ? await completePublicTicketMembers({
      db: supabase, purchase: publicTicketPurchase, tenantId: tenant.id,
      bookingIds: bookings.map(booking => booking.id),
      paymentStatus: confirmedPaymentMethod === 'card' ? 'paid' : validatedRemainingBalance === 0 ? 'free' : 'unpaid',
      paymentIntentId: stripe_payment_intent_id,
    }) : { state: 'not_applicable' };
    const invoiceRecovery = confirmedPaymentMethod !== PUBLIC_INVOICE_PO && validatedRemainingBalance > 0
      ? await enqueueCheckoutEventInvoice({
      db: supabase, tenantId: tenant.id, source: 'complex_event_booking',
      bookingGroupReference: bookingGroupRef, event, amount: validatedRemainingBalance,
      currency: unifiedCurrency, paymentMethod: confirmedPaymentMethod,
      paymentIntentId: stripe_payment_intent_id, paymentIntent: invoicePaymentEvidence,
      contact: eventInvoiceContact({ source: 'complex_event_booking', org, member: authenticatedMember }),
      purchaseOrderNumber, poToFollow,
      buildLines: accountCode => complexEventInvoiceLines({ event, resolvedItems, actualVoucherApplied, actualTfApplied }, accountCode),
      }) : { status: 'not_applicable' };

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
      member_creation: memberCreation,
      booking_group_reference: bookingGroupRef,
      bookings,
      invoice_recovery: invoiceRecovery,
      event_title: event.title
    });
  } catch (error) {
    console.error('[Complex Event Booking] Error:', error);
    return res.status(500).json({ error: 'Failed to process booking' });
  }
}

async function scheduleBookingComplexReminders(supabase, bookingId, eventId, attendeeEmail, ticketClassId, reminderEmails) {
  await scheduleComplexEventReminders({
    supabase,
    bookingId,
    eventId,
    attendeeEmail,
    ticketClassId,
    reminderEmails,
    logPrefix: '[Complex Event Booking]'
  });
}
