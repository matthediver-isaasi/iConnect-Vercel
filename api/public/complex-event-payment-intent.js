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
import { resolveAllocationInvitation } from '../_lib/allocationInvitation.js';
import { loadEventPaymentPolicy, assertEventPaymentMethodsAllowed } from '../_lib/eventPaymentPolicy.js';
import { buildEventCreditSnapshotMetadata } from '../_lib/eventPaymentPolicyCompensation.js';
import { getAllowVoucherUseAfterExpiry, isVoucherUsableForEventDate } from '../_lib/voucherExpiryPolicy.js';
import {
  ComplexEventCreditQuoteError,
  assertCreditRoleAllowed,
  buildComplexEventCreditBinding,
  calculateComplexEventCreditQuote,
  normalizeRequestedVoucherIds,
} from '../_lib/complexEventCreditQuote.js';

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

    const { event_id: requestedEventId, ticket_class_id: requestedTicketClassId, attendee_count = 1, discount_code, items,
      selected_voucher_ids: selectedVoucherIds, training_fund_amount: trainingFundAmount,
      voucher_order_manual: voucherOrderManual,
      allocation_invitation_token: allocationInvitationToken } = req.body;
    let requestedVoucherIds;
    try {
      requestedVoucherIds = normalizeRequestedVoucherIds(selectedVoucherIds);
    } catch (error) {
      return res.status(error.statusCode || 400).json({ error: error.message });
    }
    let allocationContext = null;
    if (allocationInvitationToken) {
      allocationContext = await resolveAllocationInvitation(supabase, allocationInvitationToken);
      if (allocationContext.tenantId !== tenant.id || allocationContext.eventKind !== 'complex') {
        return res.status(404).json({ error: 'Invalid allocation invitation' });
      }
      if (requestedEventId && String(requestedEventId) !== String(allocationContext.eventId)) {
        return res.status(400).json({ error: 'Event is fixed by the allocation invitation' });
      }
    }
    const event_id = allocationContext?.eventId || requestedEventId;
    const ticket_class_id = requestedTicketClassId;

    if (!event_id) {
      return res.status(400).json({ error: 'event_id is required' });
    }

    const isMultiTicket = Array.isArray(items) && items.length > 0;

    if (!isMultiTicket && !ticket_class_id) {
      return res.status(400).json({ error: 'ticket_class_id or items array is required' });
    }

    const { data: event, error: eventError } = await supabase
      .from('complex_event')
      .select('id, title, tenant_id, status, event_state, start_date')
      .eq('id', event_id)
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc'])
      .single();

    if (eventError || !event) return res.status(404).json({ error: 'Event not found' });

    try {
      const paymentPolicy = await loadEventPaymentPolicy(supabase, tenant.id);
      assertEventPaymentMethodsAllowed(paymentPolicy, {
        voucherRequested: requestedVoucherIds.length > 0,
        trainingFundRequested: Number(trainingFundAmount) > 0,
      });
    } catch (error) {
      return res.status(error.statusCode || 503).json({ error: error.message });
    }

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

    let organization = null;
    const creditsRequested = requestedVoucherIds.length > 0 || Number(trainingFundAmount) > 0;
    if (creditsRequested) {
      if (!isMember) {
        return res.status(401).json({ error: 'You must be logged in to use event credits' });
      }
      if (!member.email) {
        return res.status(400).json({ error: 'A verified member email is required to use event credits' });
      }
      if (!member.organization_id) {
        return res.status(400).json({ error: 'Organization is required to use event credits' });
      }
      const { data: organizationData, error: organizationError } = await supabase
        .from('organization')
        .select('id, training_fund_balance, training_fund_allowed_role_ids, voucher_allowed_role_ids')
        .eq('id', member.organization_id)
        .eq('tenant_id', tenant.id)
        .single();
      if (organizationError || !organizationData) {
        return res.status(400).json({ error: 'Organization is required to use event credits' });
      }
      organization = organizationData;
      try {
        if (Number(trainingFundAmount) > 0) {
          assertCreditRoleAllowed(
            organization.training_fund_allowed_role_ids,
            member.role_id,
            'the training fund',
          );
        }
        if (requestedVoucherIds.length > 0) {
          assertCreditRoleAllowed(
            organization.voucher_allowed_role_ids,
            member.role_id,
            'training vouchers',
          );
        }
      } catch (error) {
        return res.status(error.statusCode || 403).json({ error: error.message });
      }
    }

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
    if (allocationContext) {
      const covered = normalizedItems.filter((item) => String(item.ticket_class_id) === String(allocationContext.ticketTypeId));
      if (covered.length !== 1 || covered[0].attendee_count !== 1) {
        return res.status(400).json({ error: 'Allocation invitation covers exactly one fixed ticket' });
      }
    }

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

      const allocationCovered = !!allocationContext
        && String(item.ticket_class_id) === String(allocationContext.ticketTypeId);
      let finalPrice = allocationCovered ? 0 : ticket.price;

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
        subtotal_minor: itemTotal,
        allocation_covered: allocationCovered
      });
    }

    if (grandTotalMinor <= 0) {
      return res.status(400).json({ error: 'Total is zero — use free registration instead', free_registration: true });
    }

    let validatedVouchers = [];
    if (requestedVoucherIds.length > 0) {
      const { data: voucherRows, error: voucherError } = await supabase
        .from('voucher')
        .select('id, value, expires_at, issued_at')
        .in('id', requestedVoucherIds)
        .eq('organization_id', organization.id)
        .eq('status', 'active');
      if (voucherError || !Array.isArray(voucherRows) || voucherRows.length !== requestedVoucherIds.length) {
        return res.status(400).json({ error: 'One or more selected vouchers are invalid or unavailable' });
      }

      const allowVoucherAfterExpiry = await getAllowVoucherUseAfterExpiry(supabase, tenant.id);
      let voucherPolicyEventStart = event.start_date || null;
      if (!allowVoucherAfterExpiry && !voucherPolicyEventStart) {
        const { data: earliestSession, error: sessionError } = await supabase
          .from('complex_event_session')
          .select('start_time')
          .eq('complex_event_id', event.id)
          .not('start_time', 'is', null)
          .order('start_time', { ascending: true })
          .limit(1)
          .maybeSingle();
        if (sessionError) {
          return res.status(503).json({ error: 'Unable to verify voucher eligibility' });
        }
        voucherPolicyEventStart = earliestSession?.start_time || null;
      }
      if (voucherRows.some((voucher) => !isVoucherUsableForEventDate(
        voucher,
        voucherPolicyEventStart,
        allowVoucherAfterExpiry,
      ))) {
        return res.status(400).json({
          error: 'One or more selected vouchers expire before the event takes place and cannot be used for this booking.',
        });
      }
      validatedVouchers = voucherRows;
    }

    let creditQuote;
    try {
      creditQuote = calculateComplexEventCreditQuote({
        totalMinor: grandTotalMinor,
        requestedTrainingFundAmount: trainingFundAmount,
        trainingFundBalance: organization?.training_fund_balance || 0,
        requestedVoucherIds,
        vouchers: validatedVouchers,
        voucherOrderManual,
      });
    } catch (error) {
      if (error instanceof ComplexEventCreditQuoteError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      throw error;
    }

    if (creditQuote.remainingMinor <= 0) {
      return res.status(400).json({
        error: 'Total is zero after event credits — use credit-funded registration instead',
        free_registration: true,
        credits_cover_total: true,
      });
    }

    const creds = await getStripeCredentials(tenant.id, 'events');
    if (!creds?.secret_key || !creds.is_enabled) {
      return res.status(503).json({ error: 'Stripe not configured for this tenant' });
    }

    const stripe = new Stripe(creds.secret_key);

    const creditSnapshotMetadata = buildEventCreditSnapshotMetadata({
      voucherIds: requestedVoucherIds,
      voucherOrderManual,
      trainingFundAmount,
    });
    if (creditSnapshotMetadata.event_credit_voucher_ids.length > 500) {
      return res.status(400).json({ error: 'Too many vouchers selected for one card payment' });
    }

    const metadata = {
      event_id,
      ticket_class_ids: ticketClassIds.join(','),
      tenant_id: tenant.id,
      type: 'complex_event_booking',
      is_multi_ticket: isMultiTicket ? 'true' : 'false',
      gross_total_minor: String(grandTotalMinor),
      training_fund_minor: String(creditQuote.trainingFundMinor),
      voucher_minor: String(creditQuote.voucherMinor),
      credit_member_id: String(member?.id || ''),
      credit_organization_id: String(organization?.id || ''),
      credit_voucher_count: String(requestedVoucherIds.length),
      credit_binding_sha256: buildComplexEventCreditBinding({
        eventId: event_id,
        memberId: member?.id,
        organizationId: organization?.id,
        requestedTrainingFundAmount: trainingFundAmount,
        requestedVoucherIds,
        voucherOrderManual,
      }),
      member_email: member?.email || '',
      ...creditSnapshotMetadata,
    };
    if (allocationContext) {
      // Never stamp the bearer token itself into Stripe metadata.
      metadata.allocation_invitation_id = allocationContext.invitationId;
      metadata.allocation_event_id = allocationContext.eventId;
      metadata.allocation_ticket_type_id = allocationContext.ticketTypeId;
      metadata.allocation_delegate_email = allocationContext.delegateEmail;
    }

    if (!isMultiTicket) {
      metadata.ticket_class_id = ticket_class_id;
      metadata.attendee_count = String(normalizedItems[0].attendee_count);
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: creditQuote.remainingMinor,
      currency,
      metadata,
      ...(isMember && member.email ? { receipt_email: member.email } : {})
    });

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: creds.publishable_key,
      amount: creditQuote.remainingMinor,
      grossAmount: grandTotalMinor,
      trainingFundAmount: creditQuote.trainingFundMinor,
      voucherAmount: creditQuote.voucherMinor,
      currency,
      items: itemDetails
    });
  } catch (error) {
    console.error('[Complex Event Payment Intent] Error:', error);
    return res.status(500).json({ error: 'Failed to create payment intent' });
  }
}
