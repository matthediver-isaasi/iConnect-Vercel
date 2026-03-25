import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getStripeCredentials } from '../_lib/stripeCredentials.js';
import { createXeroCreditNote } from '../_lib/xero.js';
import { sendEmail } from '../_lib/emailService.js';
import Stripe from 'stripe';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const ctx = await getTenantContext(req);
  if (!ctx.isAuthenticated) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  if (!(await hasAdminAccess(ctx))) {
    return res.status(403).json({ error: 'Admin access required to approve or reject requests' });
  }

  const tenantId = ctx.tenantId;
  const { request_ids, status, review_notes, reversal_options, custom_refund_amount } = req.body;

  if (!request_ids || !Array.isArray(request_ids) || request_ids.length === 0) {
    return res.status(400).json({ error: 'request_ids is required and must be a non-empty array' });
  }

  if (!status || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
  }

  try {
    const { data: pendingRequests, error: fetchError } = await supabase
      .from('booking_cancellation_request')
      .select('*')
      .in('id', request_ids)
      .eq('tenant_id', tenantId)
      .eq('status', 'pending');

    if (fetchError) {
      console.error('[GroupApproval] Error fetching requests:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch cancellation requests' });
    }

    if (!pendingRequests || pendingRequests.length === 0) {
      return res.status(404).json({ error: 'No pending cancellation requests found' });
    }

    if (pendingRequests.length !== request_ids.length) {
      const foundIds = new Set(pendingRequests.map(r => r.id));
      const missing = request_ids.filter(id => !foundIds.has(id));
      return res.status(400).json({ error: `Some requests are not pending or not found: ${missing.join(', ')}` });
    }

    const nonGroupRequests = pendingRequests.filter(r => r.request_type !== 'group');
    if (nonGroupRequests.length > 0) {
      return res.status(400).json({ error: 'All requests must be of type "group". Use the individual approval endpoint for non-group requests.' });
    }

    const groupRefs = [...new Set(pendingRequests.map(r => r.booking_group_reference).filter(Boolean))];
    if (groupRefs.length === 0) {
      return res.status(400).json({ error: 'All requests must have a booking_group_reference for group approval' });
    }
    if (groupRefs.length > 1) {
      return res.status(400).json({ error: `All requests must belong to the same booking group. Found multiple group references: ${groupRefs.join(', ')}` });
    }

    let reviewerName = 'Admin';
    if (ctx.tenantUserId) {
      const { data: tu } = await supabase.from('tenant_user').select('email, name').eq('id', ctx.tenantUserId).single();
      if (tu) reviewerName = tu.email || tu.name || 'Admin';
    } else if (ctx.memberId) {
      const { data: m } = await supabase.from('member').select('email, first_name, last_name').eq('id', ctx.memberId).single();
      if (m) reviewerName = m.email || [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Admin';
    }
    let reversalResults = null;

    if (status === 'approved') {
      if (custom_refund_amount !== undefined && custom_refund_amount !== null) {
        const parsed = parseFloat(custom_refund_amount);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return res.status(400).json({ error: 'custom_refund_amount must be a positive number' });
        }
      }
      const reversalOptions = reversal_options || {};
      const result = await processGroupCancellation(pendingRequests, tenantId, reversalOptions, custom_refund_amount);
      if (!result.success) {
        const isValidationError = result.error && result.error.includes('custom_refund_amount');
        const statusCode = isValidationError ? 400 : 500;
        console.error('[GroupApproval] Group cancellation processing failed:', result.error);
        return res.status(statusCode).json({ error: 'Failed to process group cancellation: ' + (result.error || 'Unknown error') });
      }
      reversalResults = result.reversalResults;
    }

    const { data: updatedRows, error: updateError } = await supabase
      .from('booking_cancellation_request')
      .update({
        status,
        reviewed_by: reviewerName,
        reviewed_at: new Date().toISOString(),
        review_notes: review_notes || null,
      })
      .in('id', request_ids)
      .eq('tenant_id', tenantId)
      .eq('status', 'pending')
      .select('id');

    if (updateError) {
      console.error('[GroupApproval] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to update request statuses' });
    }

    if (!updatedRows || updatedRows.length !== request_ids.length) {
      console.warn(`[GroupApproval] Expected to update ${request_ids.length} requests but only ${updatedRows?.length || 0} were still pending — possible concurrent approval`);
    }

    try {
      await sendGroupNotificationEmails({
        requests: pendingRequests,
        status,
        tenantId,
        reviewNotes: review_notes || null,
        reversalResults,
      });
    } catch (emailErr) {
      console.error('[GroupApproval] Email notification error (non-blocking):', emailErr.message, '| requestIds:', request_ids);
    }

    console.log(`[GroupApproval] ${status} ${pendingRequests.length} group cancellation request(s)`);
    return res.json({ success: true, count: pendingRequests.length, reversalResults });
  } catch (err) {
    console.error('[GroupApproval] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function processGroupCancellation(requests, tenantId, reversalOptions = {}, custom_refund_amount = null) {
  const reversalResults = {
    trainingFund: [],
    vouchers: [],
    discountCode: null,
    programTickets: [],
    stripeRefund: null,
    xeroCreditNote: null,
    replacements: [],
  };

  try {
    const bookingIds = requests.map(r => r.booking_id);
    const { data: bookings, error: bookingsError } = await supabase
      .from('booking')
      .select('*')
      .in('id', bookingIds)
      .eq('tenant_id', tenantId);

    if (bookingsError || !bookings || bookings.length === 0) {
      return { success: false, error: 'Failed to fetch bookings for group' };
    }

    const bookingsMap = bookings.reduce((acc, b) => { acc[b.id] = b; return acc; }, {});

    const orgIds = [...new Set(bookings.map(b => b.organization_id).filter(Boolean))];
    if (orgIds.length > 1) {
      return { success: false, error: 'All bookings in a group must belong to the same organization' };
    }

    const stripeIntents = [...new Set(bookings.map(b => b.stripe_payment_intent_id).filter(Boolean))];
    if (stripeIntents.length > 1) {
      return { success: false, error: `Group bookings have multiple Stripe payment intents (${stripeIntents.length}). Cannot process consolidated refund — use individual approval.` };
    }

    const xeroInvoices = [...new Set(bookings.map(b => b.xero_invoice_id).filter(Boolean))];
    if (xeroInvoices.length > 1) {
      return { success: false, error: `Group bookings have multiple Xero invoices (${xeroInvoices.length}). Cannot process consolidated credit note — use individual approval.` };
    }

    let org = null;
    const firstBooking = bookings[0];
    const organizationId = firstBooking.organization_id;
    if (organizationId) {
      const { data: orgData } = await supabase
        .from('organization')
        .select('id, program_ticket_balances, training_fund_balance')
        .eq('id', organizationId)
        .single();
      org = orgData;
    }

    let newlyCancelledCount = 0;
    for (const booking of bookings) {
      if (booking.status === 'cancelled') {
        console.log(`[GroupApproval] Booking ${booking.id} already cancelled, skipping`);
        continue;
      }

      const { error: updateError } = await supabase
        .from('booking')
        .update({ status: 'cancelled' })
        .eq('id', booking.id);

      if (updateError) {
        console.error(`[GroupApproval] Failed to cancel booking ${booking.id}:`, updateError);
        return { success: false, error: `Failed to cancel booking ${booking.id}: ${updateError.message}` };
      }

      newlyCancelledCount++;
      console.log(`[GroupApproval] Booking ${booking.id} cancelled`);

      if (booking.training_fund_amount > 0 && org) {
        try {
          const currentBalance = org.training_fund_balance || 0;
          const newBalance = currentBalance + booking.training_fund_amount;

          await supabase
            .from('organization')
            .update({ training_fund_balance: newBalance })
            .eq('id', org.id);

          await supabase.from('training_fund_transaction').insert({
            organization_id: org.id,
            type: 'cancellation_refund',
            amount: booking.training_fund_amount,
            balance_before: currentBalance,
            balance_after: newBalance,
            reason: `Cancellation refund: ${booking.booking_reference || booking.id}`,
            booking_id: booking.id,
            created_by: booking.member_id,
            created_date: new Date().toISOString(),
            tenant_id: tenantId
          });

          org.training_fund_balance = newBalance;
          reversalResults.trainingFund.push({ bookingId: booking.id, amount: booking.training_fund_amount, success: true });
          console.log(`[GroupApproval] Training fund reinstated: £${booking.training_fund_amount} for booking ${booking.id}`);
        } catch (err) {
          console.error(`[GroupApproval] Training fund reinstatement error for booking ${booking.id}:`, err);
          reversalResults.trainingFund.push({ bookingId: booking.id, amount: booking.training_fund_amount, success: false, error: err.message });
        }
      }

      if (booking.event_id && booking.member_id && org) {
        try {
          const { data: event } = await supabase
            .from('event')
            .select('program_tag, title')
            .eq('id', booking.event_id)
            .single();

          if (event?.program_tag) {
            const currentBalances = org.program_ticket_balances || {};
            const currentBalance = currentBalances[event.program_tag] || 0;
            const newProgramBalances = { ...currentBalances, [event.program_tag]: currentBalance + 1 };

            await supabase
              .from('organization')
              .update({
                program_ticket_balances: newProgramBalances,
                last_synced: new Date().toISOString()
              })
              .eq('id', org.id);

            org.program_ticket_balances = newProgramBalances;

            await supabase.from('program_ticket_transaction').insert({
              organization_id: org.id,
              program_name: event.program_tag,
              transaction_type: 'refund',
              quantity: 1,
              booking_reference: booking.booking_reference || booking.backstage_order_id || booking.id,
              event_name: event.title || 'Unknown Event',
              member_email: booking.attendee_email || 'unknown',
              notes: `Ticket refunded via approved group cancellation request`
            });

            reversalResults.programTickets.push({ bookingId: booking.id, programTag: event.program_tag, success: true });
            console.log(`[GroupApproval] Program ticket refunded for ${event.program_tag} (booking ${booking.id})`);
          }
        } catch (err) {
          console.error(`[GroupApproval] Program ticket refund error for booking ${booking.id}:`, err);
          reversalResults.programTickets.push({ bookingId: booking.id, success: false, error: err.message });
        }
      }
    }

    // --- Restore available seats for newly cancelled bookings ---
    if (newlyCancelledCount > 0 && firstBooking.event_id) {
      try {
        const { data: eventForSeats } = await supabase
          .from('event')
          .select('id, available_seats, is_unlimited_registration')
          .eq('id', firstBooking.event_id)
          .single();

        if (eventForSeats && eventForSeats.available_seats !== null && eventForSeats.available_seats !== undefined && !eventForSeats.is_unlimited_registration) {
          const { data: newSeatCount, error: rpcError } = await supabase
            .rpc('adjust_event_seats', { p_event_id: firstBooking.event_id, p_delta: newlyCancelledCount });

          if (rpcError) {
            console.error(`[GroupApproval] RPC seat increment failed:`, rpcError.message);
            const newCount = eventForSeats.available_seats + newlyCancelledCount;
            await supabase.from('event').update({ available_seats: newCount }).eq('id', firstBooking.event_id);
            console.log(`[GroupApproval] Fallback: Incremented seats by ${newlyCancelledCount} to ${newCount}`);
          } else {
            console.log(`[GroupApproval] Seats restored by ${newlyCancelledCount}, new count: ${newSeatCount}`);
          }
        }
      } catch (err) {
        console.error(`[GroupApproval] Seat restoration error (non-blocking):`, err.message);
      }
    }

    const groupRef = firstBooking.booking_group_reference || firstBooking.booking_reference;
    const hasVoucher = bookings.some(b => parseFloat(b.voucher_amount) > 0);
    if (hasVoucher && groupRef) {
      try {
        const { data: voucherTxns } = await supabase
          .from('voucher_transaction')
          .select('*')
          .eq('booking_reference', groupRef)
          .eq('type', 'booking_usage');

        if (voucherTxns && voucherTxns.length > 0) {
          const { data: existingRefunds } = await supabase
            .from('voucher_transaction')
            .select('voucher_id')
            .eq('booking_reference', groupRef)
            .eq('type', 'cancellation_refund');
          const alreadyRefundedVoucherIds = new Set((existingRefunds || []).map(r => String(r.voucher_id)));

          for (const vtx of voucherTxns) {
            if (alreadyRefundedVoucherIds.has(String(vtx.voucher_id))) {
              console.log(`[GroupApproval] Voucher ${vtx.voucher_id} already refunded, skipping`);
              continue;
            }

            const { data: voucher } = await supabase
              .from('voucher')
              .select('*')
              .eq('id', vtx.voucher_id)
              .single();

            if (!voucher) {
              reversalResults.vouchers.push({ voucherId: vtx.voucher_id, amount: vtx.amount, success: false, error: 'Voucher not found' });
              continue;
            }

            const isExpired = voucher.expires_at && new Date(voucher.expires_at) < new Date();

            if (!isExpired) {
              const newValue = voucher.value + vtx.amount;
              await supabase
                .from('voucher')
                .update({ value: newValue, status: 'active' })
                .eq('id', voucher.id);

              await supabase.from('voucher_transaction').insert({
                voucher_id: voucher.id,
                organization_id: vtx.organization_id,
                booking_reference: groupRef,
                event_id: firstBooking.event_id,
                event_title: vtx.event_title || 'Group cancellation refund',
                member_id: firstBooking.member_id,
                member_email: vtx.member_email || firstBooking.attendee_email,
                amount: vtx.amount,
                balance_before: voucher.value,
                balance_after: newValue,
                type: 'cancellation_refund',
                created_at: new Date().toISOString(),
                tenant_id: tenantId
              });

              reversalResults.vouchers.push({ voucherId: voucher.id, code: voucher.code, amount: vtx.amount, success: true, reinstated: true });
              console.log(`[GroupApproval] Voucher ${voucher.code} reinstated: £${vtx.amount}`);
            } else {
              const replacementOption = reversalOptions.voucherReplacements?.find(r => String(r.voucherId) === String(voucher.id));
              if (replacementOption && replacementOption.newExpiryDate) {
                const newCode = `REFUND-${voucher.code}-${Date.now().toString(36).toUpperCase()}`;
                const { data: newVoucher, error: createErr } = await supabase
                  .from('voucher')
                  .insert({
                    organization_id: voucher.organization_id,
                    code: newCode,
                    value: vtx.amount,
                    description: `Replacement for expired voucher ${voucher.code} (group cancellation of ${groupRef})`,
                    expires_at: replacementOption.newExpiryDate,
                    status: 'active',
                    tenant_id: tenantId
                  })
                  .select()
                  .single();

                if (createErr) {
                  reversalResults.vouchers.push({ voucherId: voucher.id, code: voucher.code, amount: vtx.amount, success: false, expired: true, error: 'Failed to create replacement: ' + createErr.message });
                } else {
                  reversalResults.vouchers.push({ voucherId: voucher.id, code: voucher.code, amount: vtx.amount, success: true, expired: true, replacementCreated: true, newVoucherCode: newVoucher.code, newVoucherId: newVoucher.id });
                  reversalResults.replacements.push({ type: 'voucher', originalCode: voucher.code, newCode: newVoucher.code, amount: vtx.amount, expiryDate: replacementOption.newExpiryDate });
                  console.log(`[GroupApproval] Replacement voucher ${newCode} created for expired ${voucher.code}`);
                }
              } else {
                reversalResults.vouchers.push({ voucherId: voucher.id, code: voucher.code, amount: vtx.amount, success: false, expired: true, skipped: true });
              }
            }
          }
        }
      } catch (err) {
        console.error('[GroupApproval] Voucher reinstatement error:', err);
      }
    }

    const firstBookingWithDiscount = bookings.find(b => b.discount_code_id && parseFloat(b.discount_code_amount) > 0);
    if (firstBookingWithDiscount) {
      try {
        const { data: discountCode } = await supabase
          .from('discount_code')
          .select('*')
          .eq('id', firstBookingWithDiscount.discount_code_id)
          .single();

        if (discountCode) {
          const isExpired = discountCode.expires_at && new Date(discountCode.expires_at) < new Date();

          if (!isExpired) {
            await supabase
              .from('discount_code')
              .update({ current_usage_count: Math.max(0, (discountCode.current_usage_count || 1) - 1) })
              .eq('id', discountCode.id);

            if (organizationId) {
              const { data: usage } = await supabase
                .from('discount_code_usage')
                .select('id, usage_count')
                .eq('discount_code_id', discountCode.id)
                .eq('organization_id', organizationId)
                .maybeSingle();

              if (usage && usage.usage_count > 0) {
                await supabase
                  .from('discount_code_usage')
                  .update({ usage_count: usage.usage_count - 1 })
                  .eq('id', usage.id);
              }
            }

            reversalResults.discountCode = { codeId: discountCode.id, code: discountCode.code, amount: firstBookingWithDiscount.discount_code_amount, success: true, reversed: true };
            console.log(`[GroupApproval] Discount code ${discountCode.code} usage decremented`);
          } else {
            const replacementOption = reversalOptions.discountCodeReplacement;
            if (replacementOption && replacementOption.newExpiryDate) {
              const newCode = `REFUND-${discountCode.code}-${Date.now().toString(36).toUpperCase()}`;
              const { data: newDC, error: createErr } = await supabase
                .from('discount_code')
                .insert({
                  code: newCode,
                  type: discountCode.type,
                  value: discountCode.value,
                  description: `Replacement for expired code ${discountCode.code} (group cancellation of ${groupRef})`,
                  is_active: true,
                  expires_at: replacementOption.newExpiryDate,
                  max_usage_count: 1,
                  current_usage_count: 0,
                  organization_id: organizationId || null,
                  tenant_id: tenantId
                })
                .select()
                .single();

              if (createErr) {
                reversalResults.discountCode = { codeId: discountCode.id, code: discountCode.code, amount: firstBookingWithDiscount.discount_code_amount, success: false, expired: true, error: 'Failed to create replacement: ' + createErr.message };
              } else {
                reversalResults.discountCode = { codeId: discountCode.id, code: discountCode.code, amount: firstBookingWithDiscount.discount_code_amount, success: true, expired: true, replacementCreated: true, newCode: newDC.code, newCodeId: newDC.id };
                reversalResults.replacements.push({ type: 'discount_code', originalCode: discountCode.code, newCode: newDC.code, value: discountCode.value, discountType: discountCode.type, expiryDate: replacementOption.newExpiryDate });
                console.log(`[GroupApproval] Replacement discount code ${newCode} created for expired ${discountCode.code}`);
              }
            } else {
              reversalResults.discountCode = { codeId: discountCode.id, code: discountCode.code, amount: firstBookingWithDiscount.discount_code_amount, success: false, expired: true, skipped: true };
            }
          }
        }
      } catch (err) {
        console.error('[GroupApproval] Discount code reversal error:', err);
        reversalResults.discountCode = { success: false, error: err.message };
      }
    }

    let totalCardAmount = 0;
    let stripePaymentIntentId = null;
    const groupRequestIds = requests.map(r => r.id).sort().join('-');

    for (const booking of bookings) {
      if (booking.stripe_payment_intent_id && booking.payment_method === 'card') {
        const totalCost = parseFloat(booking.total_cost) || 0;
        const trainingFundAmt = parseFloat(booking.training_fund_amount) || 0;
        const voucherAmt = parseFloat(booking.voucher_amount) || 0;
        const discountAmt = parseFloat(booking.discount_code_amount) || 0;
        const accountAmt = parseFloat(booking.account_amount) || 0;
        const cardAmount = Math.max(0, totalCost - trainingFundAmt - voucherAmt - discountAmt - accountAmt);
        totalCardAmount += cardAmount;
        if (!stripePaymentIntentId) {
          stripePaymentIntentId = booking.stripe_payment_intent_id;
        }
      }
    }

    const totalGroupCost = bookings.reduce((sum, b) => sum + (parseFloat(b.total_cost) || 0), 0);
    let effectiveRefundAmount = null;
    if (custom_refund_amount !== undefined && custom_refund_amount !== null) {
      const customAmt = parseFloat(custom_refund_amount);
      if (!Number.isFinite(customAmt) || customAmt <= 0) {
        return { success: false, error: 'custom_refund_amount must be a positive number' };
      }
      const maxAllowed = Math.min(totalCardAmount > 0 ? totalCardAmount : Infinity, totalGroupCost > 0 ? totalGroupCost : Infinity);
      if (customAmt > maxAllowed) {
        return { success: false, error: `custom_refund_amount (${customAmt}) exceeds maximum refundable amount (${maxAllowed.toFixed(2)})` };
      }
      effectiveRefundAmount = customAmt;
    }

    const effectiveCardAmount = effectiveRefundAmount !== null ? effectiveRefundAmount : totalCardAmount;

    if (stripePaymentIntentId && effectiveCardAmount > 0) {
      try {
        const creds = await getStripeCredentials(tenantId, 'events');
        if (!creds || !creds.secret_key || !creds.is_enabled) {
          reversalResults.stripeRefund = {
            success: false,
            amount: effectiveCardAmount,
            requiresManualRefund: true,
            error: !creds?.is_enabled ? 'Stripe integration is disabled for this tenant' : 'Stripe not configured for this tenant',
          };
          console.warn(`[GroupApproval] Stripe not available — manual refund needed for £${totalCardAmount}`);
        } else {
          const stripe = new Stripe(creds.secret_key);
          const refundAmountPence = Math.round(effectiveCardAmount * 100);

          const paymentIntent = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
          const amountReceived = paymentIntent.amount_received || 0;
          const existingRefunds = await stripe.refunds.list({ payment_intent: stripePaymentIntentId, limit: 100 });
          const amountRefunded = existingRefunds.data.reduce((sum, r) => sum + (r.status !== 'failed' ? r.amount : 0), 0);
          const refundableAmount = amountReceived - amountRefunded;

          if (refundableAmount <= 0) {
            reversalResults.stripeRefund = {
              success: true,
              amount: effectiveCardAmount,
              alreadyRefunded: true,
              paymentIntentId: stripePaymentIntentId,
            };
            console.log(`[GroupApproval] PaymentIntent ${stripePaymentIntentId} already fully refunded`);
          } else {
            const actualRefundPence = Math.min(refundAmountPence, refundableAmount);
            const idempotencyKey = `cancel-group-refund-${groupRef || groupRequestIds}`;
            const refund = await stripe.refunds.create({
              payment_intent: stripePaymentIntentId,
              amount: actualRefundPence,
              reason: 'requested_by_customer',
              metadata: {
                booking_group_reference: groupRef || '',
                booking_count: String(bookings.length),
                cancellation_request_ids: requests.map(r => r.id).join(','),
              },
            }, {
              idempotencyKey,
            });

            const actualRefundAmount = actualRefundPence / 100;
            reversalResults.stripeRefund = {
              success: true,
              amount: actualRefundAmount,
              refundId: refund.id,
              status: refund.status,
              paymentIntentId: stripePaymentIntentId,
              partialRefund: actualRefundPence < refundAmountPence,
              consolidated: true,
              bookingCount: bookings.length,
            };
            console.log(`[GroupApproval] Consolidated Stripe refund ${refund.id}: £${actualRefundAmount} for ${bookings.length} bookings`);
          }
        }
      } catch (err) {
        console.error('[GroupApproval] Stripe refund error:', err.message);
        reversalResults.stripeRefund = {
          success: false,
          amount: effectiveCardAmount,
          requiresManualRefund: true,
          error: err.message,
          paymentIntentId: stripePaymentIntentId,
        };
      }
    }

    const bookingsWithXero = bookings.filter(b => b.xero_invoice_id);
    if (bookingsWithXero.length > 0) {
      try {
        const xeroInvoiceId = bookingsWithXero[0].xero_invoice_id;
        const bookingsForThisInvoice = bookings.filter(b => b.xero_invoice_id === xeroInvoiceId);
        const fullCreditAmount = bookingsForThisInvoice.reduce((sum, b) => sum + (parseFloat(b.total_cost) || 0), 0);
        const totalCreditAmount = effectiveRefundAmount !== null ? effectiveRefundAmount : fullCreditAmount;

        if (totalCreditAmount > 0) {
          const xeroBooking = bookingsWithXero[0];
          const attendeeNames = bookings
            .map(b => [b.attendee_first_name, b.attendee_last_name].filter(Boolean).join(' '))
            .filter(Boolean);
          const uniqueNames = [...new Set(attendeeNames)];
          const namesText = uniqueNames.length > 3
            ? `${uniqueNames.slice(0, 3).join(', ')} +${uniqueNames.length - 3} more`
            : uniqueNames.join(', ');

          const result = await createXeroCreditNote({
            appTenantId: tenantId,
            invoiceId: xeroBooking.xero_invoice_id,
            creditAmount: totalCreditAmount,
            description: `Group cancellation of ${bookings.length} tickets (${groupRef || 'group'}) — ${namesText}`.trim(),
            reference: `Cancel-Group: ${groupRef || groupRequestIds}`,
          });

          if (result.skipped) {
            reversalResults.xeroCreditNote = {
              success: false,
              skipped: true,
              reason: result.reason,
              amount: totalCreditAmount,
              invoiceNumber: result.invoiceNumber,
              requiresManualAction: true,
            };
            console.log(`[GroupApproval] Xero credit note skipped: ${result.reason}`);
          } else {
            reversalResults.xeroCreditNote = {
              success: true,
              amount: result.amount,
              creditNoteId: result.creditNoteId,
              creditNoteNumber: result.creditNoteNumber,
              allocated: result.allocated,
              invoiceNumber: result.invoiceNumber,
              alreadyExisted: result.alreadyExisted || false,
              consolidated: true,
              bookingCount: bookings.length,
            };
            console.log(`[GroupApproval] Consolidated Xero credit note ${result.creditNoteNumber}: £${result.amount} for ${bookings.length} bookings`);

            if (result.creditNoteId) {
              for (const booking of bookings) {
                const { error: cnUpdateError } = await supabase
                  .from('booking')
                  .update({
                    xero_credit_note_id: result.creditNoteId,
                    xero_credit_note_number: result.creditNoteNumber,
                  })
                  .eq('id', booking.id);

                if (cnUpdateError) {
                  console.warn(`[GroupApproval] Failed to store credit note on booking ${booking.id}: ${cnUpdateError.message}`);
                }
              }
            }
          }
        }
      } catch (err) {
        const errCreditAmount = effectiveRefundAmount !== null ? effectiveRefundAmount : totalGroupCost;
        console.error('[GroupApproval] Xero credit note error:', err.message);
        reversalResults.xeroCreditNote = {
          success: false,
          amount: errCreditAmount,
          requiresManualAction: true,
          error: err.message,
        };
      }
    }

    return { success: true, reversalResults };
  } catch (err) {
    console.error('[GroupApproval] Error processing group cancellation:', err);
    return { success: false, error: err.message };
  }
}

async function sendGroupNotificationEmails({ requests, status, tenantId, reviewNotes, reversalResults }) {
  if (!requests || requests.length === 0) return;

  const firstRequest = requests[0];
  const bookingIds = requests.map(r => r.booking_id);

  const { data: bookings } = await supabase
    .from('booking')
    .select('id, attendee_email, attendee_first_name, attendee_last_name, member_id, booking_reference, booking_group_reference, event_id, total_cost')
    .in('id', bookingIds)
    .eq('tenant_id', tenantId);

  if (!bookings || bookings.length === 0) {
    console.warn('[GroupNotification] No bookings found, skipping emails');
    return;
  }

  const groupRef = bookings[0].booking_group_reference || bookings[0].booking_reference || '';

  let eventName = 'your event';
  const eventId = bookings[0].event_id || firstRequest.event_id;
  if (eventId) {
    const { data: event } = await supabase
      .from('event')
      .select('title')
      .eq('id', eventId)
      .eq('tenant_id', tenantId)
      .single();
    if (event?.title) eventName = event.title;
  }

  let bookerEmail = null;
  let bookerFirstName = null;
  const memberId = firstRequest.member_id;
  if (memberId) {
    const { data: member } = await supabase
      .from('member')
      .select('email, first_name')
      .eq('id', memberId)
      .eq('tenant_id', tenantId)
      .single();
    if (member) {
      bookerEmail = member.email;
      bookerFirstName = member.first_name;
    }
  }

  const isApproved = status === 'approved';
  const ticketCount = bookings.length;
  const attendeeNames = bookings
    .map(b => [b.attendee_first_name, b.attendee_last_name].filter(Boolean).join(' '))
    .filter(Boolean);
  const uniqueNames = [...new Set(attendeeNames)];

  const subject = isApproved
    ? `Group Booking Cancellation Confirmed — ${eventName} (${ticketCount} tickets)`
    : `Group Booking Cancellation Request Rejected — ${eventName}`;

  const financialLines = [];
  if (isApproved && reversalResults) {
    const rr = reversalResults;
    const totalTrainingFund = (rr.trainingFund || []).filter(t => t.success).reduce((sum, t) => sum + t.amount, 0);
    if (totalTrainingFund > 0) {
      financialLines.push(`Training fund: £${totalTrainingFund.toFixed(2)} reinstated`);
    }
    for (const v of rr.vouchers || []) {
      if (v.reinstated) financialLines.push(`Voucher ${v.code}: £${Number(v.amount).toFixed(2)} reinstated`);
      if (v.replacementCreated) {
        const replacement = rr.replacements?.find(r => r.type === 'voucher' && r.newCode === v.newVoucherCode);
        const expiryText = replacement?.expiryDate ? ` (expires ${replacement.expiryDate})` : '';
        financialLines.push(`Replacement voucher ${v.newVoucherCode} issued${expiryText}`);
      }
    }
    if (rr.discountCode?.reversed) {
      financialLines.push(`Discount code ${rr.discountCode.code} usage reversed`);
    }
    if (rr.discountCode?.replacementCreated) {
      financialLines.push(`Replacement discount code ${rr.discountCode.newCode} issued`);
    }
    if (rr.stripeRefund?.success && !rr.stripeRefund?.alreadyRefunded) {
      financialLines.push(`Card refund: £${Number(rr.stripeRefund.amount).toFixed(2)} will be returned to your payment method`);
    }
    if (rr.xeroCreditNote?.success) {
      financialLines.push(`Credit note ${rr.xeroCreditNote.creditNoteNumber} raised for £${Number(rr.xeroCreditNote.amount).toFixed(2)}`);
    }
    const programCount = (rr.programTickets || []).filter(p => p.success).length;
    if (programCount > 0) {
      financialLines.push(`${programCount} program ticket(s) refunded`);
    }
  }

  const buildEmailHtml = (recipientName, isBooker) => {
    let body = '';

    if (isApproved) {
      body += `<p>Hi ${recipientName},</p>`;
      if (isBooker) {
        body += `<p>Your group booking for <strong>${eventName}</strong> has been cancelled. <strong>${ticketCount} ticket(s)</strong> were cancelled.</p>`;
      } else {
        body += `<p>A booking for <strong>${eventName}</strong> that included your ticket has been cancelled.</p>`;
      }

      if (groupRef) {
        body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${groupRef}</strong></p>`;
      }

      if (uniqueNames.length > 0 && isBooker) {
        body += `<p style="color: #666; font-size: 14px;">Cancelled attendees: ${uniqueNames.join(', ')}</p>`;
      }

      if (financialLines.length > 0) {
        body += `<div style="margin: 20px 0; padding: 16px; background-color: #f8f9fa; border-radius: 6px; border: 1px solid #e9ecef;">`;
        body += `<p style="margin: 0 0 10px 0; font-weight: 600; color: #333;">Financial Summary</p>`;
        body += `<ul style="margin: 0; padding-left: 20px; color: #555;">`;
        for (const line of financialLines) {
          body += `<li style="margin-bottom: 6px;">${line}</li>`;
        }
        body += `</ul>`;
        body += `</div>`;
      }

      body += `<p style="color: #666; font-size: 14px;">If you have any questions, please don't hesitate to get in touch.</p>`;
    } else {
      body += `<p>Hi ${recipientName},</p>`;
      if (isBooker) {
        body += `<p>Your group cancellation request for <strong>${eventName}</strong> (${ticketCount} tickets) has been reviewed and <strong>was not approved</strong>.</p>`;
      } else {
        body += `<p>A cancellation request for <strong>${eventName}</strong> that included your ticket has been reviewed and <strong>was not approved</strong>.</p>`;
      }

      if (groupRef) {
        body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${groupRef}</strong></p>`;
      }

      if (reviewNotes) {
        body += `<div style="margin: 20px 0; padding: 16px; background-color: #fff8e1; border-radius: 6px; border: 1px solid #ffe082;">`;
        body += `<p style="margin: 0 0 6px 0; font-weight: 600; color: #333;">Reviewer Notes</p>`;
        body += `<p style="margin: 0; color: #555;">${reviewNotes.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
        body += `</div>`;
      }

      body += `<p style="color: #666; font-size: 14px;">Your bookings remain active. If you have any questions, please get in touch.</p>`;
    }

    return body;
  };

  const sentEmails = new Set();

  if (bookerEmail) {
    try {
      const result = await sendEmail({
        to: bookerEmail,
        subject,
        html: buildEmailHtml(bookerFirstName || 'there', true),
        tenantId,
      });
      if (result?.success) {
        sentEmails.add(bookerEmail.toLowerCase());
        console.log(`[GroupNotification] Sent ${status} notification to booker: ${bookerEmail}`);
      }
    } catch (err) {
      console.error(`[GroupNotification] Failed to email booker ${bookerEmail}:`, err.message);
    }
  }

  for (const booking of bookings) {
    const attendeeEmail = booking.attendee_email;
    if (!attendeeEmail || sentEmails.has(attendeeEmail.toLowerCase())) continue;

    try {
      const result = await sendEmail({
        to: attendeeEmail,
        subject,
        html: buildEmailHtml(booking.attendee_first_name || 'there', false),
        tenantId,
      });
      if (result?.success) {
        sentEmails.add(attendeeEmail.toLowerCase());
        console.log(`[GroupNotification] Sent ${status} notification to attendee: ${attendeeEmail}`);
      }
    } catch (err) {
      console.error(`[GroupNotification] Failed to email attendee ${attendeeEmail}:`, err.message);
    }
  }
}
