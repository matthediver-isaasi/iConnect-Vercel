/**
 * Unified cancellation email builder.
 *
 * Replaces the per-flow HTML/financial-summary scaffolding that previously lived
 * in three separate places:
 *   - api/_lib/bookingCancellation.js (sendEventDeletionCancellationEmail)
 *   - api/booking-cancellation-requests/[requestId].js (sendCancellationNotificationEmails)
 *   - api/booking-cancellation-requests/approve-group.js (sendGroupNotificationEmails)
 *
 * Per-flow wording (single vs group, approved vs rejected, event-deleted) is
 * driven entirely by the `flow` / `isGroup` parameters — not by which file is
 * calling. The rendered HTML is byte-equivalent to the previous per-file
 * implementations for matching inputs.
 */

export const CANCELLATION_FLOW_EVENT_DELETED = 'event_deleted';
export const CANCELLATION_FLOW_REQUEST_APPROVED = 'request_approved';
export const CANCELLATION_FLOW_REQUEST_REJECTED = 'request_rejected';

function escapeHtml(value) {
  return String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the financial-summary lines from a `reversalResults` object.
 *
 * The shape of `reversalResults` differs between flows: the request flows use
 * scalar fields (e.g. `trainingFund: { success, amount }`), the group flow
 * uses arrays (e.g. `trainingFund: [{ success, amount }, ...]`). The flow
 * also gates whether manual-action fallback lines and program-ticket lines
 * are emitted.
 */
export function buildFinancialSummaryLines({ flow, isGroup, reversalResults }) {
  const lines = [];
  if (!reversalResults) return lines;
  const rr = reversalResults;
  const isEventDeleted = flow === CANCELLATION_FLOW_EVENT_DELETED;

  if (isGroup) {
    const totalTrainingFund = (rr.trainingFund || [])
      .filter(t => t.success)
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);
    if (totalTrainingFund > 0) {
      lines.push(`Training fund: £${totalTrainingFund.toFixed(2)} reinstated`);
    }
  } else if (rr.trainingFund?.success) {
    lines.push(`Training fund: £${Number(rr.trainingFund.amount).toFixed(2)} reinstated`);
  }

  for (const v of rr.vouchers || []) {
    if (v.reinstated) {
      lines.push(`Voucher ${v.code}: £${Number(v.amount).toFixed(2)} reinstated`);
    }
    if (v.replacementCreated) {
      // Event-deletion flow historically did not look up expiry text; if no
      // `replacements` array is supplied the lookup yields no expiry text,
      // matching the previous output exactly.
      const replacement = rr.replacements?.find(
        r => r.type === 'voucher' && r.newCode === v.newVoucherCode
      );
      const expiryText = replacement?.expiryDate ? ` (expires ${replacement.expiryDate})` : '';
      lines.push(`Replacement voucher ${v.newVoucherCode} issued${expiryText}`);
    }
  }

  if (rr.discountCode?.reversed) {
    lines.push(`Discount code ${rr.discountCode.code} usage reversed`);
  }
  if (rr.discountCode?.replacementCreated) {
    lines.push(`Replacement discount code ${rr.discountCode.newCode} issued`);
  }

  if (rr.stripeRefund?.success && !rr.stripeRefund?.alreadyRefunded) {
    lines.push(`Card refund: £${Number(rr.stripeRefund.amount).toFixed(2)} will be returned to your payment method`);
  } else if (isEventDeleted && rr.stripeRefund && rr.stripeRefund.requiresManualRefund) {
    lines.push(`Card refund of £${Number(rr.stripeRefund.amount).toFixed(2)} could not be processed automatically — our team will be in touch`);
  }

  if (rr.xeroCreditNote?.success) {
    lines.push(`Credit note ${rr.xeroCreditNote.creditNoteNumber} raised for £${Number(rr.xeroCreditNote.amount).toFixed(2)}`);
  } else if (isEventDeleted && rr.xeroCreditNote?.requiresManualAction) {
    lines.push(`A credit note will be issued shortly`);
  }

  if (isGroup) {
    const programCount = (rr.programTickets || []).filter(p => p.success).length;
    if (programCount > 0) {
      lines.push(`${programCount} program ticket(s) refunded`);
    }
  }

  return lines;
}

function buildSubject({ flow, isGroup, eventName, ticketCount }) {
  if (flow === CANCELLATION_FLOW_EVENT_DELETED) {
    // Event-deletion flow also handles non-event-deletion admin cancellations
    // via the same helper; the caller signals the wording through the
    // `eventDeletedSubject` flag set in buildCancellationEmail.
    return `Event cancelled — ${eventName}`;
  }
  if (flow === CANCELLATION_FLOW_REQUEST_APPROVED) {
    return isGroup
      ? `Group Booking Cancellation Confirmed — ${eventName} (${ticketCount} tickets)`
      : `Booking Cancellation Confirmed — ${eventName}`;
  }
  // request_rejected
  return isGroup
    ? `Group Booking Cancellation Request Rejected — ${eventName}`
    : `Booking Cancellation Request Rejected — ${eventName}`;
}

/**
 * Build the cancellation email subject + HTML body.
 *
 * @param {object} params
 * @param {'event_deleted'|'request_approved'|'request_rejected'} params.flow
 * @param {boolean} params.isGroup
 * @param {string}  params.eventName
 * @param {string}  params.recipientName
 * @param {boolean} params.isBooker        Whether the recipient is the booker (vs attendee).
 * @param {string}  [params.bookingRef]    Single-booking ref or group ref.
 * @param {string}  [params.attendeeName]  Single-flow display name for "booking you made for X".
 * @param {number}  [params.ticketCount]   Group-flow ticket count.
 * @param {string[]} [params.uniqueAttendeeNames] Group-flow list of cancelled attendee names.
 * @param {boolean} [params.hasDifferentBookerAttendee] Event-deleted flow: booker email != attendee email.
 * @param {boolean} [params.eventDeletedReason] Event-deleted flow: true if reason is event_deleted (controls wording).
 * @param {object|null} [params.reversalResults]
 * @param {string|null} [params.reviewNotes]
 * @param {string|null} [params.organiserMessage]
 * @returns {{ subject: string, html: string }}
 */
export function buildCancellationEmail({
  flow,
  isGroup = false,
  eventName,
  recipientName,
  isBooker = false,
  bookingRef = '',
  attendeeName = '',
  ticketCount = 0,
  uniqueAttendeeNames = [],
  hasDifferentBookerAttendee = false,
  eventDeletedReason = false,
  reversalResults = null,
  reviewNotes = null,
  organiserMessage = null,
}) {
  const safeName = recipientName || 'there';
  const isEventDeletedFlow = flow === CANCELLATION_FLOW_EVENT_DELETED;
  const isApproved = flow === CANCELLATION_FLOW_REQUEST_APPROVED;
  const isRejected = flow === CANCELLATION_FLOW_REQUEST_REJECTED;

  // Subject — event-deleted flow may also be reused for admin cancellations
  // where the reason is not event_deleted; in that case use the
  // "Booking cancellation confirmed" subject.
  let subject;
  if (isEventDeletedFlow) {
    subject = eventDeletedReason
      ? `Event cancelled — ${eventName}`
      : `Booking cancellation confirmed — ${eventName}`;
  } else {
    subject = buildSubject({ flow, isGroup, eventName, ticketCount });
  }

  let body = `<p>Hi ${safeName},</p>`;

  // Lead paragraph
  if (isEventDeletedFlow) {
    if (eventDeletedReason) {
      if (isBooker && hasDifferentBookerAttendee) {
        body += `<p><strong>${eventName}</strong> has been cancelled by the organiser. The booking you made for <strong>${attendeeName}</strong> has therefore been cancelled.</p>`;
      } else {
        body += `<p><strong>${eventName}</strong> has been cancelled by the organiser, so your booking has been cancelled.</p>`;
      }
    } else {
      if (isBooker && hasDifferentBookerAttendee) {
        body += `<p>A booking you made for <strong>${attendeeName}</strong> for <strong>${eventName}</strong> has been cancelled.</p>`;
      } else {
        body += `<p>Your booking for <strong>${eventName}</strong> has been cancelled.</p>`;
      }
    }
  } else if (isApproved) {
    if (isGroup) {
      if (isBooker) {
        body += `<p>Your group booking for <strong>${eventName}</strong> has been cancelled. <strong>${ticketCount} ticket(s)</strong> were cancelled.</p>`;
      } else {
        body += `<p>A booking for <strong>${eventName}</strong> that included your ticket has been cancelled.</p>`;
      }
    } else {
      if (isBooker) {
        body += `<p>A booking you made for <strong>${attendeeName}</strong> for <strong>${eventName}</strong> has been cancelled.</p>`;
      } else {
        body += `<p>Your booking for <strong>${eventName}</strong> has been cancelled as requested.</p>`;
      }
    }
  } else if (isRejected) {
    if (isGroup) {
      if (isBooker) {
        body += `<p>Your group cancellation request for <strong>${eventName}</strong> (${ticketCount} tickets) has been reviewed and <strong>was not approved</strong>.</p>`;
      } else {
        body += `<p>A cancellation request for <strong>${eventName}</strong> that included your ticket has been reviewed and <strong>was not approved</strong>.</p>`;
      }
    } else {
      if (isBooker) {
        body += `<p>A cancellation request for a booking you made for <strong>${attendeeName}</strong> for <strong>${eventName}</strong> has been reviewed and <strong>was not approved</strong>.</p>`;
      } else {
        body += `<p>Your cancellation request for <strong>${eventName}</strong> has been reviewed and <strong>was not approved</strong>.</p>`;
      }
    }
  }

  // Booking reference
  if (bookingRef) {
    if (isEventDeletedFlow) {
      body += `<p style="color:#666;font-size:14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
    } else {
      body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
    }
  }

  // Group: cancelled attendees list (booker only, approved only)
  if (isGroup && isApproved && isBooker && uniqueAttendeeNames.length > 0) {
    body += `<p style="color: #666; font-size: 14px;">Cancelled attendees: ${uniqueAttendeeNames.join(', ')}</p>`;
  }

  // Organiser message (event-deletion only)
  if (isEventDeletedFlow && organiserMessage) {
    const safeOrganiserMessage = escapeHtml(organiserMessage).replace(/\n/g, '<br>');
    body += `<div style="margin:20px 0;padding:16px;background:#f8f9fa;border:1px solid #e9ecef;border-radius:6px;">`;
    body += `<p style="margin:0 0 6px 0;font-weight:600;">A message from the organiser</p>`;
    body += `<p style="margin:0;color:#555;">${safeOrganiserMessage}</p>`;
    body += `</div>`;
  }

  // Financial summary (only when something was reversed and not on rejection)
  if (!isRejected) {
    const financialLines = buildFinancialSummaryLines({ flow, isGroup, reversalResults });
    if (financialLines.length > 0) {
      if (isEventDeletedFlow) {
        body += `<div style="margin:20px 0;padding:16px;background:#f8f9fa;border:1px solid #e9ecef;border-radius:6px;">`;
        body += `<p style="margin:0 0 10px 0;font-weight:600;">Refund summary</p>`;
        body += `<ul style="margin:0;padding-left:20px;color:#555;">`;
        for (const line of financialLines) body += `<li style="margin-bottom:6px;">${line}</li>`;
        body += `</ul></div>`;
      } else {
        body += `<div style="margin: 20px 0; padding: 16px; background-color: #f8f9fa; border-radius: 6px; border: 1px solid #e9ecef;">`;
        body += `<p style="margin: 0 0 10px 0; font-weight: 600; color: #333;">Financial Summary</p>`;
        body += `<ul style="margin: 0; padding-left: 20px; color: #555;">`;
        for (const line of financialLines) body += `<li style="margin-bottom: 6px;">${line}</li>`;
        body += `</ul>`;
        body += `</div>`;
      }
    }
  }

  // Reviewer notes (rejection only)
  if (isRejected && reviewNotes) {
    body += `<div style="margin: 20px 0; padding: 16px; background-color: #fff8e1; border-radius: 6px; border: 1px solid #ffe082;">`;
    body += `<p style="margin: 0 0 6px 0; font-weight: 600; color: #333;">Reviewer Notes</p>`;
    body += `<p style="margin: 0; color: #555;">${escapeHtml(reviewNotes)}</p>`;
    body += `</div>`;
  }

  // Closing line
  if (isEventDeletedFlow) {
    body += `<p style="color:#666;font-size:14px;">If you have any questions, please get in touch.</p>`;
  } else if (isApproved) {
    body += `<p style="color: #666; font-size: 14px;">If you have any questions, please don't hesitate to get in touch.</p>`;
  } else {
    // rejected
    if (isGroup) {
      body += `<p style="color: #666; font-size: 14px;">Your bookings remain active. If you have any questions, please get in touch.</p>`;
    } else {
      body += `<p style="color: #666; font-size: 14px;">Your booking remains active. If you have any questions, please get in touch.</p>`;
    }
  }

  return { subject, html: body };
}
