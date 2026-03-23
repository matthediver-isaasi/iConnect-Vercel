import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getStripeCredentials } from '../_lib/stripeCredentials.js';
import { createXeroCreditNote } from '../_lib/xero.js';
import { sendEmail } from '../_lib/emailService.js';
import Stripe from 'stripe';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'PATCH') {
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
  const { requestId } = req.query;

  if (!requestId) {
    return res.status(400).json({ error: 'Request ID is required' });
  }

  const { status, review_notes, reversal_options, custom_refund_amount } = req.body;

  if (!status || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
  }

  try {
    const { data: request, error: fetchError } = await supabase
      .from('booking_cancellation_request')
      .select('*')
      .eq('id', requestId)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchError || !request) {
      return res.status(404).json({ error: 'Cancellation request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request has already been ${request.status}` });
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
      const reversalOptions = reversal_options || {};
      const cancellationResult = await processCancellation(request, tenantId, reversalOptions, custom_refund_amount);
      if (!cancellationResult.success) {
        console.error('[CancellationRequest] Cancellation processing failed:', cancellationResult.error);
        return res.status(500).json({ error: 'Failed to process cancellation: ' + (cancellationResult.error || 'Unknown error') });
      }
      reversalResults = cancellationResult.reversalResults;
    }

    const { data: updated, error: updateError } = await supabase
      .from('booking_cancellation_request')
      .update({
        status,
        reviewed_by: reviewerName,
        reviewed_at: new Date().toISOString(),
        review_notes: review_notes || null,
      })
      .eq('id', requestId)
      .select()
      .single();

    if (updateError) {
      console.error('[CancellationRequest] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to update request status' });
    }

    sendCancellationNotificationEmails({
      request,
      status,
      tenantId,
      reviewNotes: review_notes || null,
      reversalResults,
    }).catch(err => {
      console.error('[CancellationRequest] Email notification error (non-blocking):', err.message);
    });

    return res.json({ request: updated, reversalResults });
  } catch (err) {
    console.error('[CancellationRequest] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function processCancellation(request, tenantId, reversalOptions = {}, custom_refund_amount = null) {
  const reversalResults = {
    trainingFund: null,
    vouchers: [],
    discountCode: null,
    programTicket: null,
    stripeRefund: null,
    xeroCreditNote: null,
    replacements: [],
  };

  try {
    const { data: booking, error: bookingError } = await supabase
      .from('booking')
      .select('*')
      .eq('id', request.booking_id)
      .eq('tenant_id', tenantId)
      .single();

    if (bookingError || !booking) {
      return { success: false, error: 'Booking not found' };
    }

    if (booking.status === 'cancelled') {
      return { success: true, alreadyCancelled: true, reversalResults };
    }

    const { error: updateError } = await supabase
      .from('booking')
      .update({ status: 'cancelled' })
      .eq('id', booking.id);

    if (updateError) {
      return { success: false, error: 'Failed to update booking status' };
    }

    console.log(`[CancellationRequest] Booking ${booking.id} cancelled`);

    // --- Restore available seats ---
    if (booking.event_id) {
      try {
        const { data: eventForSeats } = await supabase
          .from('event')
          .select('id, available_seats, is_unlimited_registration')
          .eq('id', booking.event_id)
          .single();

        if (eventForSeats && eventForSeats.available_seats !== null && eventForSeats.available_seats !== undefined && !eventForSeats.is_unlimited_registration) {
          const { data: newSeatCount, error: rpcError } = await supabase
            .rpc('adjust_event_seats', { p_event_id: booking.event_id, p_delta: 1 });

          if (rpcError) {
            console.error(`[CancellationRequest] RPC seat increment failed:`, rpcError.message);
            const newCount = eventForSeats.available_seats + 1;
            await supabase.from('event').update({ available_seats: newCount }).eq('id', booking.event_id);
            console.log(`[CancellationRequest] Fallback: Incremented seats to ${newCount}`);
          } else {
            console.log(`[CancellationRequest] Seats restored, new count: ${newSeatCount}`);
          }
        }
      } catch (err) {
        console.error(`[CancellationRequest] Seat restoration error (non-blocking):`, err.message);
      }
    }

    const organizationId = booking.organization_id;
    let org = null;
    if (organizationId) {
      const { data: orgData } = await supabase
        .from('organization')
        .select('id, program_ticket_balances, training_fund_balance')
        .eq('id', organizationId)
        .single();
      org = orgData;
    }

    // --- Training Fund Reinstatement ---
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
        reversalResults.trainingFund = { amount: booking.training_fund_amount, success: true };
        console.log(`[CancellationRequest] Training fund reinstated: £${booking.training_fund_amount}`);
      } catch (err) {
        console.error('[CancellationRequest] Training fund reinstatement error:', err);
        reversalResults.trainingFund = { amount: booking.training_fund_amount, success: false, error: err.message };
      }
    }

    // --- Voucher Reinstatement ---
    if (booking.voucher_amount > 0 && booking.booking_reference) {
      try {
        const groupRef = booking.booking_group_reference || booking.booking_reference;
        const { data: voucherTxns } = await supabase
          .from('voucher_transaction')
          .select('*')
          .eq('booking_reference', groupRef)
          .eq('type', 'booking_usage');

        if (voucherTxns && voucherTxns.length > 0) {
          // Check if a cancellation_refund already exists for this group to prevent duplicates
          const { data: existingRefunds } = await supabase
            .from('voucher_transaction')
            .select('voucher_id')
            .eq('booking_reference', booking.booking_reference)
            .eq('type', 'cancellation_refund');
          const alreadyRefundedVoucherIds = new Set((existingRefunds || []).map(r => String(r.voucher_id)));

          for (const vtx of voucherTxns) {
            if (alreadyRefundedVoucherIds.has(String(vtx.voucher_id))) {
              console.log(`[CancellationRequest] Voucher ${vtx.voucher_id} already refunded for this booking, skipping`);
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
                booking_reference: booking.booking_reference,
                event_id: booking.event_id,
                event_title: vtx.event_title || 'Cancellation refund',
                member_id: booking.member_id,
                member_email: vtx.member_email || booking.attendee_email,
                amount: vtx.amount,
                balance_before: voucher.value,
                balance_after: newValue,
                type: 'cancellation_refund',
                created_at: new Date().toISOString(),
                tenant_id: tenantId
              });

              reversalResults.vouchers.push({ voucherId: voucher.id, code: voucher.code, amount: vtx.amount, success: true, reinstated: true });
              console.log(`[CancellationRequest] Voucher ${voucher.code} reinstated: £${vtx.amount}`);
            } else {
              // Voucher expired — check if admin wants a replacement
              const replacementOption = reversalOptions.voucherReplacements?.find(r => String(r.voucherId) === String(voucher.id));
              if (replacementOption && replacementOption.newExpiryDate) {
                const newCode = `REFUND-${voucher.code}-${Date.now().toString(36).toUpperCase()}`;
                const { data: newVoucher, error: createErr } = await supabase
                  .from('voucher')
                  .insert({
                    organization_id: voucher.organization_id,
                    code: newCode,
                    value: vtx.amount,
                    description: `Replacement for expired voucher ${voucher.code} (cancellation of ${booking.booking_reference})`,
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
                  console.log(`[CancellationRequest] Replacement voucher ${newCode} created for expired ${voucher.code}`);
                }
              } else {
                reversalResults.vouchers.push({ voucherId: voucher.id, code: voucher.code, amount: vtx.amount, success: false, expired: true, skipped: true });
                console.log(`[CancellationRequest] Voucher ${voucher.code} expired — no replacement requested`);
              }
            }
          }
        }
      } catch (err) {
        console.error('[CancellationRequest] Voucher reinstatement error:', err);
      }
    }

    // --- Discount Code Usage Reversal ---
    if (booking.discount_code_id && booking.discount_code_amount > 0) {
      try {
        const { data: discountCode } = await supabase
          .from('discount_code')
          .select('*')
          .eq('id', booking.discount_code_id)
          .single();

        if (discountCode) {
          const isExpired = discountCode.expires_at && new Date(discountCode.expires_at) < new Date();

          // Only decrement once per booking group — check if this is the first ticket in the group
          const isFirstInGroup = !booking.booking_group_reference ||
            booking.booking_reference === booking.booking_group_reference ||
            booking.booking_reference === `${booking.booking_group_reference}-1`;

          if (!isExpired && isFirstInGroup) {
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

            reversalResults.discountCode = { codeId: discountCode.id, code: discountCode.code, amount: booking.discount_code_amount, success: true, reversed: true };
            console.log(`[CancellationRequest] Discount code ${discountCode.code} usage decremented`);
          } else if (isExpired && isFirstInGroup) {
            // Discount code expired — check if admin wants a replacement
            const replacementOption = reversalOptions.discountCodeReplacement;
            if (replacementOption && replacementOption.newExpiryDate) {
              const newCode = `REFUND-${discountCode.code}-${Date.now().toString(36).toUpperCase()}`;
              const { data: newDC, error: createErr } = await supabase
                .from('discount_code')
                .insert({
                  code: newCode,
                  type: discountCode.type,
                  value: discountCode.value,
                  description: `Replacement for expired code ${discountCode.code} (cancellation of ${booking.booking_reference})`,
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
                reversalResults.discountCode = { codeId: discountCode.id, code: discountCode.code, amount: booking.discount_code_amount, success: false, expired: true, error: 'Failed to create replacement: ' + createErr.message };
              } else {
                reversalResults.discountCode = { codeId: discountCode.id, code: discountCode.code, amount: booking.discount_code_amount, success: true, expired: true, replacementCreated: true, newCode: newDC.code, newCodeId: newDC.id };
                reversalResults.replacements.push({ type: 'discount_code', originalCode: discountCode.code, newCode: newDC.code, value: discountCode.value, discountType: discountCode.type, expiryDate: replacementOption.newExpiryDate });
                console.log(`[CancellationRequest] Replacement discount code ${newCode} created for expired ${discountCode.code}`);
              }
            } else {
              reversalResults.discountCode = { codeId: discountCode.id, code: discountCode.code, amount: booking.discount_code_amount, success: false, expired: true, skipped: true };
              console.log(`[CancellationRequest] Discount code ${discountCode.code} expired — no replacement requested`);
            }
          } else if (!isFirstInGroup) {
            reversalResults.discountCode = { codeId: discountCode.id, code: discountCode.code, amount: booking.discount_code_amount, success: true, skippedNotFirstInGroup: true };
          }
        }
      } catch (err) {
        console.error('[CancellationRequest] Discount code reversal error:', err);
        reversalResults.discountCode = { success: false, error: err.message };
      }
    }

    // --- Program Ticket Refund (existing logic) ---
    if (booking.event_id && booking.member_id) {
      const { data: event } = await supabase
        .from('event')
        .select('program_tag, title')
        .eq('id', booking.event_id)
        .single();

      if (event?.program_tag && org) {
        const currentBalances = org.program_ticket_balances || {};
        const currentBalance = currentBalances[event.program_tag] || 0;

        await supabase
          .from('organization')
          .update({
            program_ticket_balances: { ...currentBalances, [event.program_tag]: currentBalance + 1 },
            last_synced: new Date().toISOString()
          })
          .eq('id', org.id);

        await supabase.from('program_ticket_transaction').insert({
          organization_id: org.id,
          program_name: event.program_tag,
          transaction_type: 'refund',
          quantity: 1,
          booking_reference: booking.booking_reference || booking.backstage_order_id || booking.id,
          event_name: event.title || 'Unknown Event',
          member_email: booking.attendee_email || 'unknown',
          notes: `Ticket refunded via approved cancellation request`
        });

        reversalResults.programTicket = { programTag: event.program_tag, success: true };
        console.log(`[CancellationRequest] Program ticket refunded for ${event.program_tag}`);
      }
    }

    // --- Stripe Refund ---
    if (booking.stripe_payment_intent_id && booking.payment_method === 'card') {
      try {
        const totalCost = parseFloat(booking.total_cost) || 0;
        const trainingFundAmt = parseFloat(booking.training_fund_amount) || 0;
        const voucherAmt = parseFloat(booking.voucher_amount) || 0;
        const discountAmt = parseFloat(booking.discount_code_amount) || 0;
        const accountAmt = parseFloat(booking.account_amount) || 0;
        const fullCardAmount = Math.max(0, totalCost - trainingFundAmt - voucherAmt - discountAmt - accountAmt);

        let cardAmount = fullCardAmount;
        if (custom_refund_amount !== undefined && custom_refund_amount !== null) {
          const customAmt = parseFloat(custom_refund_amount);
          if (!Number.isFinite(customAmt) || customAmt <= 0) {
            console.warn(`[CancellationRequest] Invalid custom_refund_amount: ${custom_refund_amount}, using full amount`);
          } else {
            cardAmount = Math.min(customAmt, fullCardAmount);
          }
        }

        if (cardAmount > 0) {
          const creds = await getStripeCredentials(tenantId, 'events');
          if (!creds || !creds.secret_key || !creds.is_enabled) {
            reversalResults.stripeRefund = {
              success: false,
              amount: cardAmount,
              requiresManualRefund: true,
              error: !creds?.is_enabled ? 'Stripe integration is disabled for this tenant' : 'Stripe not configured for this tenant',
            };
            console.warn(`[CancellationRequest] Stripe not available — manual refund needed for £${cardAmount}`);
          } else {
            const stripe = new Stripe(creds.secret_key);
            const refundAmountPence = Math.round(cardAmount * 100);

            const paymentIntent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
            const amountReceived = paymentIntent.amount_received || 0;
            const amountRefunded = paymentIntent.amount_received
              ? (await stripe.refunds.list({ payment_intent: booking.stripe_payment_intent_id, limit: 100 })).data.reduce((sum, r) => sum + (r.status !== 'failed' ? r.amount : 0), 0)
              : 0;
            const refundableAmount = amountReceived - amountRefunded;

            if (refundableAmount <= 0) {
              reversalResults.stripeRefund = {
                success: true,
                amount: cardAmount,
                alreadyRefunded: true,
                paymentIntentId: booking.stripe_payment_intent_id,
              };
              console.log(`[CancellationRequest] PaymentIntent ${booking.stripe_payment_intent_id} already fully refunded`);
            } else {
              const actualRefundPence = Math.min(refundAmountPence, refundableAmount);
              const idempotencyKey = `cancel-refund-${request.id}-${booking.id}`;
              const refund = await stripe.refunds.create({
                payment_intent: booking.stripe_payment_intent_id,
                amount: actualRefundPence,
                reason: 'requested_by_customer',
                metadata: {
                  booking_id: booking.id,
                  booking_reference: booking.booking_reference || '',
                  cancellation_request_id: request.id,
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
                paymentIntentId: booking.stripe_payment_intent_id,
                partialRefund: actualRefundPence < refundAmountPence,
              };
              console.log(`[CancellationRequest] Stripe refund ${refund.id} created: £${actualRefundAmount} (status: ${refund.status})`);
            }
          }
        } else {
          console.log(`[CancellationRequest] Card amount is £0 — no Stripe refund needed`);
        }
      } catch (err) {
        const cardAmount = Math.max(0, (parseFloat(booking.total_cost) || 0) - (parseFloat(booking.training_fund_amount) || 0) - (parseFloat(booking.voucher_amount) || 0) - (parseFloat(booking.discount_code_amount) || 0) - (parseFloat(booking.account_amount) || 0));
        console.error('[CancellationRequest] Stripe refund error:', err.message);
        reversalResults.stripeRefund = {
          success: false,
          amount: cardAmount,
          requiresManualRefund: true,
          error: err.message,
          paymentIntentId: booking.stripe_payment_intent_id,
        };
      }
    }

    // --- Xero Credit Note ---
    if (booking.xero_invoice_id) {
      try {
        const fullCreditAmount = parseFloat(booking.total_cost) || 0;
        let creditAmount = fullCreditAmount;
        if (custom_refund_amount !== undefined && custom_refund_amount !== null) {
          const customAmt = parseFloat(custom_refund_amount);
          if (Number.isFinite(customAmt) && customAmt > 0) {
            creditAmount = Math.min(customAmt, fullCreditAmount);
          }
        }

        if (creditAmount > 0) {
          const result = await createXeroCreditNote({
            appTenantId: tenantId,
            invoiceId: booking.xero_invoice_id,
            creditAmount,
            description: `Cancellation of booking ${booking.booking_reference || booking.id} — ${booking.attendee_first_name || ''} ${booking.attendee_last_name || ''}`.trim(),
            reference: `Cancel: ${booking.booking_reference || booking.id}`,
          });

          if (result.skipped) {
            reversalResults.xeroCreditNote = {
              success: false,
              skipped: true,
              reason: result.reason,
              amount: creditAmount,
              invoiceNumber: result.invoiceNumber,
              requiresManualAction: true,
            };
            console.log(`[CancellationRequest] Xero credit note skipped: ${result.reason}`);
          } else {
            reversalResults.xeroCreditNote = {
              success: true,
              amount: result.amount,
              creditNoteId: result.creditNoteId,
              creditNoteNumber: result.creditNoteNumber,
              allocated: result.allocated,
              invoiceNumber: result.invoiceNumber,
              alreadyExisted: result.alreadyExisted || false,
            };
            console.log(`[CancellationRequest] Xero credit note ${result.creditNoteNumber} created for £${result.amount}`);

            if (result.creditNoteId) {
              const { error: cnUpdateError } = await supabase
                .from('booking')
                .update({
                  xero_credit_note_id: result.creditNoteId,
                  xero_credit_note_number: result.creditNoteNumber,
                })
                .eq('id', booking.id);

              if (cnUpdateError) {
                console.warn(`[CancellationRequest] Failed to store credit note on booking: ${cnUpdateError.message}`);
              }
            }
          }
        }
      } catch (err) {
        const creditAmount = parseFloat(booking.total_cost) || 0;
        console.error('[CancellationRequest] Xero credit note error:', err.message);
        reversalResults.xeroCreditNote = {
          success: false,
          amount: creditAmount,
          requiresManualAction: true,
          error: err.message,
          invoiceId: booking.xero_invoice_id,
          invoiceNumber: booking.xero_invoice_number,
        };
      }
    }

    return { success: true, reversalResults };
  } catch (err) {
    console.error('[CancellationRequest] Error processing cancellation:', err);
    return { success: false, error: err.message };
  }
}

async function sendCancellationNotificationEmails({ request, status, tenantId, reviewNotes, reversalResults }) {
  const { data: booking } = await supabase
    .from('booking')
    .select('attendee_email, attendee_first_name, attendee_last_name, member_id, booking_reference, booking_group_reference, event_id, total_cost')
    .eq('id', request.booking_id)
    .eq('tenant_id', tenantId)
    .single();

  if (!booking) {
    console.warn('[CancellationEmail] Booking not found, skipping email');
    return;
  }

  let eventName = 'your event';
  if (booking.event_id) {
    const { data: event } = await supabase
      .from('event')
      .select('title')
      .eq('id', booking.event_id)
      .eq('tenant_id', tenantId)
      .single();
    if (event?.title) eventName = event.title;
  }

  let bookerEmail = null;
  let bookerFirstName = null;
  if (booking.member_id) {
    const { data: member } = await supabase
      .from('member')
      .select('email, first_name')
      .eq('id', booking.member_id)
      .eq('tenant_id', tenantId)
      .single();
    if (member) {
      bookerEmail = member.email;
      bookerFirstName = member.first_name;
    }
  }

  const attendeeName = [booking.attendee_first_name, booking.attendee_last_name].filter(Boolean).join(' ') || 'there';
  const bookingRef = booking.booking_reference || booking.booking_group_reference || '';
  const isApproved = status === 'approved';

  const subject = isApproved
    ? `Booking Cancellation Confirmed — ${eventName}`
    : `Booking Cancellation Request Rejected — ${eventName}`;

  const financialLines = [];
  if (isApproved && reversalResults) {
    const rr = reversalResults;
    if (rr.trainingFund?.success) {
      financialLines.push(`Training fund: £${Number(rr.trainingFund.amount).toFixed(2)} reinstated`);
    }
    for (const v of rr.vouchers || []) {
      if (v.reinstated) financialLines.push(`Voucher ${v.code}: £${Number(v.amount).toFixed(2)} reinstated`);
      if (v.replacementCreated) {
        const replacement = reversalResults.replacements?.find(r => r.type === 'voucher' && r.newCode === v.newVoucherCode);
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
  }

  const buildEmailHtml = (recipientName, isBooker) => {
    let body = '';

    if (isApproved) {
      if (isBooker) {
        body += `<p>Hi ${recipientName},</p>`;
        body += `<p>A booking you made for <strong>${attendeeName}</strong> for <strong>${eventName}</strong> has been cancelled.</p>`;
      } else {
        body += `<p>Hi ${recipientName},</p>`;
        body += `<p>Your booking for <strong>${eventName}</strong> has been cancelled as requested.</p>`;
      }

      if (bookingRef) {
        body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
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
        body += `<p>A cancellation request for a booking you made for <strong>${attendeeName}</strong> for <strong>${eventName}</strong> has been reviewed and <strong>was not approved</strong>.</p>`;
      } else {
        body += `<p>Your cancellation request for <strong>${eventName}</strong> has been reviewed and <strong>was not approved</strong>.</p>`;
      }

      if (bookingRef) {
        body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
      }

      if (reviewNotes) {
        body += `<div style="margin: 20px 0; padding: 16px; background-color: #fff8e1; border-radius: 6px; border: 1px solid #ffe082;">`;
        body += `<p style="margin: 0 0 6px 0; font-weight: 600; color: #333;">Reviewer Notes</p>`;
        body += `<p style="margin: 0; color: #555;">${reviewNotes.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
        body += `</div>`;
      }

      body += `<p style="color: #666; font-size: 14px;">Your booking remains active. If you have any questions, please get in touch.</p>`;
    }

    return body;
  };

  const attendeeEmail = booking.attendee_email;

  if (attendeeEmail) {
    try {
      const result = await sendEmail({
        to: attendeeEmail,
        subject,
        html: buildEmailHtml(booking.attendee_first_name || attendeeName, false),
        tenantId,
      });
      if (result?.success) {
        console.log(`[CancellationEmail] Sent ${status} notification to attendee: ${attendeeEmail}`);
      } else {
        console.error(`[CancellationEmail] Failed to email attendee ${attendeeEmail}: ${result?.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error(`[CancellationEmail] Failed to email attendee ${attendeeEmail}:`, err.message);
    }
  }

  if (bookerEmail && bookerEmail.toLowerCase() !== (attendeeEmail || '').toLowerCase()) {
    try {
      const result = await sendEmail({
        to: bookerEmail,
        subject,
        html: buildEmailHtml(bookerFirstName || 'there', true),
        tenantId,
      });
      if (result?.success) {
        console.log(`[CancellationEmail] Sent ${status} notification to booker: ${bookerEmail}`);
      } else {
        console.error(`[CancellationEmail] Failed to email booker ${bookerEmail}: ${result?.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error(`[CancellationEmail] Failed to email booker ${bookerEmail}:`, err.message);
    }
  }
}
