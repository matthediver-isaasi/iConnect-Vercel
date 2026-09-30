/**
 * Snapshot test for the unified cancellation email helper.
 *
 * Runs with plain Node (no test runner): `node tests/cancellationEmail.snapshot.test.mjs`.
 * Locks the rendered subject + HTML body against the original per-flow
 * implementations that lived in:
 *   - api/_lib/bookingCancellation.js (sendEventDeletionCancellationEmail)
 *   - api/booking-cancellation-requests/[requestId].js (sendCancellationNotificationEmails)
 *   - api/booking-cancellation-requests/approve-group.js (sendGroupNotificationEmails)
 *
 * Exit code 0 = parity, 1 = a wording branch drifted.
 */

import {
  buildCancellationEmail,
  buildFinancialSummaryLines,
  CANCELLATION_FLOW_EVENT_DELETED,
  CANCELLATION_FLOW_REQUEST_APPROVED,
  CANCELLATION_FLOW_REQUEST_REJECTED,
} from '../api/_lib/cancellationEmail.js';

// ---------- Verbatim copies of the pre-refactor builders ----------

function legacyEventDeletedHtml({
  recipientName, isBooker, isEventDeleted, eventName, attendeeName,
  attendeeEmail, bookerEmail, bookingRef, organiserMessage, financialLines,
}) {
  const safeName = recipientName || 'there';
  const safeOrganiserMessage = organiserMessage
    ? String(organiserMessage).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
    : null;
  let body = `<p>Hi ${safeName},</p>`;
  if (isEventDeleted) {
    if (isBooker && attendeeEmail && attendeeEmail.toLowerCase() !== (bookerEmail || '').toLowerCase()) {
      body += `<p><strong>${eventName}</strong> has been cancelled by the organiser. The booking you made for <strong>${attendeeName}</strong> has therefore been cancelled.</p>`;
    } else {
      body += `<p><strong>${eventName}</strong> has been cancelled by the organiser, so your booking has been cancelled.</p>`;
    }
  } else {
    if (isBooker && attendeeEmail && attendeeEmail.toLowerCase() !== (bookerEmail || '').toLowerCase()) {
      body += `<p>A booking you made for <strong>${attendeeName}</strong> for <strong>${eventName}</strong> has been cancelled.</p>`;
    } else {
      body += `<p>Your booking for <strong>${eventName}</strong> has been cancelled.</p>`;
    }
  }
  if (bookingRef) body += `<p style="color:#666;font-size:14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
  if (safeOrganiserMessage) {
    body += `<div style="margin:20px 0;padding:16px;background:#f8f9fa;border:1px solid #e9ecef;border-radius:6px;">`;
    body += `<p style="margin:0 0 6px 0;font-weight:600;">A message from the organiser</p>`;
    body += `<p style="margin:0;color:#555;">${safeOrganiserMessage}</p></div>`;
  }
  if (financialLines.length > 0) {
    body += `<div style="margin:20px 0;padding:16px;background:#f8f9fa;border:1px solid #e9ecef;border-radius:6px;">`;
    body += `<p style="margin:0 0 10px 0;font-weight:600;">Refund summary</p>`;
    body += `<ul style="margin:0;padding-left:20px;color:#555;">`;
    for (const line of financialLines) body += `<li style="margin-bottom:6px;">${line}</li>`;
    body += `</ul></div>`;
  }
  body += `<p style="color:#666;font-size:14px;">If you have any questions, please get in touch.</p>`;
  return body;
}

function legacySingleRequestHtml({
  recipientName, isBooker, isApproved, eventName, attendeeName, bookingRef,
  financialLines, reviewNotes,
}) {
  const safeName = recipientName || 'there';
  let body = '';
  if (isApproved) {
    if (isBooker) {
      body += `<p>Hi ${safeName},</p>`;
      body += `<p>A booking you made for <strong>${attendeeName}</strong> for <strong>${eventName}</strong> has been cancelled.</p>`;
    } else {
      body += `<p>Hi ${safeName},</p>`;
      body += `<p>Your booking for <strong>${eventName}</strong> has been cancelled as requested.</p>`;
    }
    if (bookingRef) body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
    if (financialLines.length > 0) {
      body += `<div style="margin: 20px 0; padding: 16px; background-color: #f8f9fa; border-radius: 6px; border: 1px solid #e9ecef;">`;
      body += `<p style="margin: 0 0 10px 0; font-weight: 600; color: #333;">Financial Summary</p>`;
      body += `<ul style="margin: 0; padding-left: 20px; color: #555;">`;
      for (const line of financialLines) body += `<li style="margin-bottom: 6px;">${line}</li>`;
      body += `</ul></div>`;
    }
    body += `<p style="color: #666; font-size: 14px;">If you have any questions, please don't hesitate to get in touch.</p>`;
  } else {
    body += `<p>Hi ${safeName},</p>`;
    if (isBooker) {
      body += `<p>A cancellation request for a booking you made for <strong>${attendeeName}</strong> for <strong>${eventName}</strong> has been reviewed and <strong>was not approved</strong>.</p>`;
    } else {
      body += `<p>Your cancellation request for <strong>${eventName}</strong> has been reviewed and <strong>was not approved</strong>.</p>`;
    }
    if (bookingRef) body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${bookingRef}</strong></p>`;
    if (reviewNotes) {
      body += `<div style="margin: 20px 0; padding: 16px; background-color: #fff8e1; border-radius: 6px; border: 1px solid #ffe082;">`;
      body += `<p style="margin: 0 0 6px 0; font-weight: 600; color: #333;">Reviewer Notes</p>`;
      body += `<p style="margin: 0; color: #555;">${String(reviewNotes).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p></div>`;
    }
    body += `<p style="color: #666; font-size: 14px;">Your booking remains active. If you have any questions, please get in touch.</p>`;
  }
  return body;
}

function legacyGroupHtml({
  recipientName, isBooker, isApproved, eventName, ticketCount, groupRef,
  uniqueNames, financialLines, reviewNotes,
}) {
  let body = '';
  if (isApproved) {
    body += `<p>Hi ${recipientName},</p>`;
    if (isBooker) {
      body += `<p>Your group booking for <strong>${eventName}</strong> has been cancelled. <strong>${ticketCount} ticket(s)</strong> were cancelled.</p>`;
    } else {
      body += `<p>A booking for <strong>${eventName}</strong> that included your ticket has been cancelled.</p>`;
    }
    if (groupRef) body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${groupRef}</strong></p>`;
    if (uniqueNames.length > 0 && isBooker) body += `<p style="color: #666; font-size: 14px;">Cancelled attendees: ${uniqueNames.join(', ')}</p>`;
    if (financialLines.length > 0) {
      body += `<div style="margin: 20px 0; padding: 16px; background-color: #f8f9fa; border-radius: 6px; border: 1px solid #e9ecef;">`;
      body += `<p style="margin: 0 0 10px 0; font-weight: 600; color: #333;">Financial Summary</p>`;
      body += `<ul style="margin: 0; padding-left: 20px; color: #555;">`;
      for (const line of financialLines) body += `<li style="margin-bottom: 6px;">${line}</li>`;
      body += `</ul></div>`;
    }
    body += `<p style="color: #666; font-size: 14px;">If you have any questions, please don't hesitate to get in touch.</p>`;
  } else {
    body += `<p>Hi ${recipientName},</p>`;
    if (isBooker) {
      body += `<p>Your group cancellation request for <strong>${eventName}</strong> (${ticketCount} tickets) has been reviewed and <strong>was not approved</strong>.</p>`;
    } else {
      body += `<p>A cancellation request for <strong>${eventName}</strong> that included your ticket has been reviewed and <strong>was not approved</strong>.</p>`;
    }
    if (groupRef) body += `<p style="color: #666; font-size: 14px;">Booking reference: <strong>${groupRef}</strong></p>`;
    if (reviewNotes) {
      body += `<div style="margin: 20px 0; padding: 16px; background-color: #fff8e1; border-radius: 6px; border: 1px solid #ffe082;">`;
      body += `<p style="margin: 0 0 6px 0; font-weight: 600; color: #333;">Reviewer Notes</p>`;
      body += `<p style="margin: 0; color: #555;">${reviewNotes.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p></div>`;
    }
    body += `<p style="color: #666; font-size: 14px;">Your bookings remain active. If you have any questions, please get in touch.</p>`;
  }
  return body;
}

// Legacy financial-summary builders, copied verbatim per flow.
function legacyEventDeletedFinLines(rr) {
  const lines = [];
  if (!rr) return lines;
  if (rr.trainingFund?.success) lines.push(`Training fund: £${Number(rr.trainingFund.amount).toFixed(2)} reinstated`);
  for (const v of rr.vouchers || []) {
    if (v.reinstated) lines.push(`Voucher ${v.code}: £${Number(v.amount).toFixed(2)} reinstated`);
    if (v.replacementCreated) lines.push(`Replacement voucher ${v.newVoucherCode} issued`);
  }
  if (rr.discountCode?.reversed) lines.push(`Discount code ${rr.discountCode.code} usage reversed`);
  if (rr.stripeRefund?.success && !rr.stripeRefund?.alreadyRefunded) {
    lines.push(`Card refund: £${Number(rr.stripeRefund.amount).toFixed(2)} will be returned to your payment method`);
  } else if (rr.stripeRefund && rr.stripeRefund.requiresManualRefund) {
    lines.push(`Card refund of £${Number(rr.stripeRefund.amount).toFixed(2)} could not be processed automatically — our team will be in touch`);
  }
  if (rr.xeroCreditNote?.success) {
    lines.push(`Credit note ${rr.xeroCreditNote.creditNoteNumber} raised for £${Number(rr.xeroCreditNote.amount).toFixed(2)}`);
  } else if (rr.xeroCreditNote?.requiresManualAction) {
    lines.push(`A credit note will be issued shortly`);
  }
  return lines;
}

function legacySingleRequestFinLines(rr) {
  const lines = [];
  if (!rr) return lines;
  if (rr.trainingFund?.success) lines.push(`Training fund: £${Number(rr.trainingFund.amount).toFixed(2)} reinstated`);
  for (const v of rr.vouchers || []) {
    if (v.reinstated) lines.push(`Voucher ${v.code}: £${Number(v.amount).toFixed(2)} reinstated`);
    if (v.replacementCreated) {
      const replacement = rr.replacements?.find(r => r.type === 'voucher' && r.newCode === v.newVoucherCode);
      const expiryText = replacement?.expiryDate ? ` (expires ${replacement.expiryDate})` : '';
      lines.push(`Replacement voucher ${v.newVoucherCode} issued${expiryText}`);
    }
  }
  if (rr.discountCode?.reversed) lines.push(`Discount code ${rr.discountCode.code} usage reversed`);
  if (rr.discountCode?.replacementCreated) lines.push(`Replacement discount code ${rr.discountCode.newCode} issued`);
  if (rr.stripeRefund?.success && !rr.stripeRefund?.alreadyRefunded) {
    lines.push(`Card refund: £${Number(rr.stripeRefund.amount).toFixed(2)} will be returned to your payment method`);
  }
  if (rr.xeroCreditNote?.success) {
    lines.push(`Credit note ${rr.xeroCreditNote.creditNoteNumber} raised for £${Number(rr.xeroCreditNote.amount).toFixed(2)}`);
  }
  return lines;
}

function legacyGroupFinLines(rr) {
  const lines = [];
  if (!rr) return lines;
  const totalTrainingFund = (rr.trainingFund || []).filter(t => t.success).reduce((s, t) => s + Number(t.amount || 0), 0);
  if (totalTrainingFund > 0) lines.push(`Training fund: £${totalTrainingFund.toFixed(2)} reinstated`);
  for (const v of rr.vouchers || []) {
    if (v.reinstated) lines.push(`Voucher ${v.code}: £${Number(v.amount).toFixed(2)} reinstated`);
    if (v.replacementCreated) {
      const replacement = rr.replacements?.find(r => r.type === 'voucher' && r.newCode === v.newVoucherCode);
      const expiryText = replacement?.expiryDate ? ` (expires ${replacement.expiryDate})` : '';
      lines.push(`Replacement voucher ${v.newVoucherCode} issued${expiryText}`);
    }
  }
  if (rr.discountCode?.reversed) lines.push(`Discount code ${rr.discountCode.code} usage reversed`);
  if (rr.discountCode?.replacementCreated) lines.push(`Replacement discount code ${rr.discountCode.newCode} issued`);
  if (rr.stripeRefund?.success && !rr.stripeRefund?.alreadyRefunded) {
    lines.push(`Card refund: £${Number(rr.stripeRefund.amount).toFixed(2)} will be returned to your payment method`);
  }
  if (rr.xeroCreditNote?.success) {
    lines.push(`Credit note ${rr.xeroCreditNote.creditNoteNumber} raised for £${Number(rr.xeroCreditNote.amount).toFixed(2)}`);
  }
  const programCount = (rr.programTickets || []).filter(p => p.success).length;
  if (programCount > 0) lines.push(`${programCount} program ticket(s) refunded`);
  return lines;
}

// ---------- Test harness ----------

let pass = 0, fail = 0;
function check(label, expected, actual) {
  if (expected === actual) {
    pass++;
    return;
  }
  fail++;
  console.log(`\n--- FAIL: ${label} ---`);
  const len = Math.min(expected.length, actual.length);
  for (let i = 0; i < len; i++) {
    if (expected[i] !== actual[i]) {
      console.log(`Diff at offset ${i}:`);
      console.log(`  expected: ...${JSON.stringify(expected.slice(Math.max(0, i - 20), i + 40))}`);
      console.log(`  actual:   ...${JSON.stringify(actual.slice(Math.max(0, i - 20), i + 40))}`);
      return;
    }
  }
  console.log(`Length differs: expected=${expected.length}, actual=${actual.length}`);
  console.log('expected tail:', JSON.stringify(expected.slice(-100)));
  console.log('actual tail:  ', JSON.stringify(actual.slice(-100)));
}

// ---------- Fixtures ----------

const fullReversal = {
  trainingFund: { success: true, amount: 50 },
  vouchers: [{ reinstated: true, code: 'VC1', amount: 10, replacementCreated: true, newVoucherCode: 'VC2' }],
  replacements: [{ type: 'voucher', newCode: 'VC2', expiryDate: '2026-12-31' }],
  discountCode: { reversed: true, code: 'DC1', replacementCreated: true, newCode: 'DC2' },
  stripeRefund: { success: true, amount: 25.5 },
  xeroCreditNote: { success: true, creditNoteNumber: 'CN-1', amount: 75 },
};

const manualBranches = {
  stripeRefund: { success: false, requiresManualRefund: true, amount: 30 },
  xeroCreditNote: { success: false, requiresManualAction: true },
};

const groupReversal = {
  trainingFund: [{ success: true, amount: 20 }, { success: true, amount: 30 }, { success: false, amount: 99 }],
  vouchers: [{ reinstated: true, code: 'GV', amount: 8, replacementCreated: true, newVoucherCode: 'GV2' }],
  replacements: [{ type: 'voucher', newCode: 'GV2', expiryDate: '2027-01-01' }],
  discountCode: { reversed: true, code: 'GD', replacementCreated: true, newCode: 'GD2' },
  stripeRefund: { success: true, amount: 200 },
  xeroCreditNote: { success: true, creditNoteNumber: 'CN-G', amount: 250 },
  programTickets: [{ success: true }, { success: true }, { success: false }],
};

// ---------- Financial-summary parity ----------

check(
  'event-deleted financial lines (full)',
  JSON.stringify(legacyEventDeletedFinLines(fullReversal)),
  JSON.stringify(buildFinancialSummaryLines({
    flow: CANCELLATION_FLOW_EVENT_DELETED, isGroup: false,
    // Event-deletion historically didn't supply replacements/discount-replacement;
    // strip them so we match prior behaviour exactly.
    reversalResults: { ...fullReversal, replacements: undefined, discountCode: { reversed: true, code: 'DC1' } },
  })),
);

check(
  'event-deleted financial lines (manual branches)',
  JSON.stringify(legacyEventDeletedFinLines(manualBranches)),
  JSON.stringify(buildFinancialSummaryLines({
    flow: CANCELLATION_FLOW_EVENT_DELETED, isGroup: false, reversalResults: manualBranches,
  })),
);

check(
  'single-request financial lines (full)',
  JSON.stringify(legacySingleRequestFinLines(fullReversal)),
  JSON.stringify(buildFinancialSummaryLines({
    flow: CANCELLATION_FLOW_REQUEST_APPROVED, isGroup: false, reversalResults: fullReversal,
  })),
);

check(
  'single-request financial lines (manual branches gated off)',
  JSON.stringify(legacySingleRequestFinLines(manualBranches)),
  JSON.stringify(buildFinancialSummaryLines({
    flow: CANCELLATION_FLOW_REQUEST_APPROVED, isGroup: false, reversalResults: manualBranches,
  })),
);

check(
  'group financial lines (full)',
  JSON.stringify(legacyGroupFinLines(groupReversal)),
  JSON.stringify(buildFinancialSummaryLines({
    flow: CANCELLATION_FLOW_REQUEST_APPROVED, isGroup: true, reversalResults: groupReversal,
  })),
);

// ---------- Subject + body parity per flow ----------

const eventName = 'Wed Conf';
const groupName = 'Group Trip';

// Event-deleted, deleted-reason, attendee
{
  const fin = legacyEventDeletedFinLines(fullReversal);
  const expected = legacyEventDeletedHtml({
    recipientName: 'Alice', isBooker: false, isEventDeleted: true, eventName,
    attendeeName: 'Alice Smith', attendeeEmail: 'a@x.com', bookerEmail: 'b@x.com',
    bookingRef: 'BR-1', organiserMessage: 'Sorry!\n<bad>', financialLines: fin,
  });
  const got = buildCancellationEmail({
    flow: CANCELLATION_FLOW_EVENT_DELETED, isGroup: false, eventName,
    recipientName: 'Alice', isBooker: false, bookingRef: 'BR-1',
    attendeeName: 'Alice Smith', hasDifferentBookerAttendee: true,
    eventDeletedReason: true,
    reversalResults: { ...fullReversal, replacements: undefined, discountCode: { reversed: true, code: 'DC1' } },
    organiserMessage: 'Sorry!\n<bad>',
  });
  check('event-deleted/deleted-reason attendee body', expected, got.html);
  check('event-deleted/deleted-reason subject', `Event cancelled — ${eventName}`, got.subject);
}

// Event-deleted, non-deleted reason, booker
{
  const expected = legacyEventDeletedHtml({
    recipientName: 'Bob', isBooker: true, isEventDeleted: false, eventName,
    attendeeName: 'Alice Smith', attendeeEmail: 'a@x.com', bookerEmail: 'b@x.com',
    bookingRef: '', organiserMessage: null, financialLines: [],
  });
  const got = buildCancellationEmail({
    flow: CANCELLATION_FLOW_EVENT_DELETED, isGroup: false, eventName,
    recipientName: 'Bob', isBooker: true, bookingRef: '', attendeeName: 'Alice Smith',
    hasDifferentBookerAttendee: true, eventDeletedReason: false,
    reversalResults: null, organiserMessage: null,
  });
  check('event-deleted/non-deleted booker body', expected, got.html);
  check('event-deleted/non-deleted subject', `Booking cancellation confirmed — ${eventName}`, got.subject);
}

// Event-deleted with manual-branch financial lines
{
  const fin = legacyEventDeletedFinLines(manualBranches);
  const expected = legacyEventDeletedHtml({
    recipientName: 'Sam', isBooker: false, isEventDeleted: true, eventName,
    attendeeName: 'Sam', attendeeEmail: 'a@x.com', bookerEmail: 'a@x.com',
    bookingRef: 'BR-X', organiserMessage: null, financialLines: fin,
  });
  const got = buildCancellationEmail({
    flow: CANCELLATION_FLOW_EVENT_DELETED, isGroup: false, eventName,
    recipientName: 'Sam', isBooker: false, bookingRef: 'BR-X', attendeeName: 'Sam',
    hasDifferentBookerAttendee: false, eventDeletedReason: true,
    reversalResults: manualBranches, organiserMessage: null,
  });
  check('event-deleted manual-branch body', expected, got.html);
}

// Single request approved, attendee
{
  const fin = legacySingleRequestFinLines(fullReversal);
  const expected = legacySingleRequestHtml({
    recipientName: 'Carol', isBooker: false, isApproved: true, eventName: 'Yoga',
    attendeeName: 'Carol J', bookingRef: 'BR-9', financialLines: fin, reviewNotes: null,
  });
  const got = buildCancellationEmail({
    flow: CANCELLATION_FLOW_REQUEST_APPROVED, isGroup: false, eventName: 'Yoga',
    recipientName: 'Carol', isBooker: false, bookingRef: 'BR-9', attendeeName: 'Carol J',
    reversalResults: fullReversal,
  });
  check('single-approved attendee body', expected, got.html);
  check('single-approved subject', 'Booking Cancellation Confirmed — Yoga', got.subject);
}

// Single request approved, booker
{
  const fin = legacySingleRequestFinLines(fullReversal);
  const expected = legacySingleRequestHtml({
    recipientName: 'Pat', isBooker: true, isApproved: true, eventName: 'Yoga',
    attendeeName: 'Carol J', bookingRef: 'BR-9', financialLines: fin, reviewNotes: null,
  });
  const got = buildCancellationEmail({
    flow: CANCELLATION_FLOW_REQUEST_APPROVED, isGroup: false, eventName: 'Yoga',
    recipientName: 'Pat', isBooker: true, bookingRef: 'BR-9', attendeeName: 'Carol J',
    reversalResults: fullReversal,
  });
  check('single-approved booker body', expected, got.html);
}

// Single request rejected, booker
{
  const expected = legacySingleRequestHtml({
    recipientName: 'Dan', isBooker: true, isApproved: false, eventName: 'Yoga',
    attendeeName: 'Carol J', bookingRef: '', financialLines: [], reviewNotes: 'No <good>',
  });
  const got = buildCancellationEmail({
    flow: CANCELLATION_FLOW_REQUEST_REJECTED, isGroup: false, eventName: 'Yoga',
    recipientName: 'Dan', isBooker: true, bookingRef: '', attendeeName: 'Carol J',
    reversalResults: null, reviewNotes: 'No <good>',
  });
  check('single-rejected booker body', expected, got.html);
  check('single-rejected subject', 'Booking Cancellation Request Rejected — Yoga', got.subject);
}

// Single request rejected, attendee
{
  const expected = legacySingleRequestHtml({
    recipientName: 'Lin', isBooker: false, isApproved: false, eventName: 'Yoga',
    attendeeName: 'Lin', bookingRef: 'BR-3', financialLines: [], reviewNotes: null,
  });
  const got = buildCancellationEmail({
    flow: CANCELLATION_FLOW_REQUEST_REJECTED, isGroup: false, eventName: 'Yoga',
    recipientName: 'Lin', isBooker: false, bookingRef: 'BR-3', attendeeName: 'Lin',
    reversalResults: null, reviewNotes: null,
  });
  check('single-rejected attendee body', expected, got.html);
}

// Group approved, booker
{
  const fin = legacyGroupFinLines(groupReversal);
  const expected = legacyGroupHtml({
    recipientName: 'Eve', isBooker: true, isApproved: true, eventName: groupName,
    ticketCount: 3, groupRef: 'GRP-1', uniqueNames: ['A B', 'C D'],
    financialLines: fin, reviewNotes: null,
  });
  const got = buildCancellationEmail({
    flow: CANCELLATION_FLOW_REQUEST_APPROVED, isGroup: true, eventName: groupName,
    recipientName: 'Eve', isBooker: true, bookingRef: 'GRP-1', ticketCount: 3,
    uniqueAttendeeNames: ['A B', 'C D'], reversalResults: groupReversal,
  });
  check('group-approved booker body', expected, got.html);
  check('group-approved subject', `Group Booking Cancellation Confirmed — ${groupName} (3 tickets)`, got.subject);
}

// Group approved, attendee (no attendee list, booker-only)
{
  const fin = legacyGroupFinLines(groupReversal);
  const expected = legacyGroupHtml({
    recipientName: 'Z', isBooker: false, isApproved: true, eventName: groupName,
    ticketCount: 3, groupRef: 'GRP-1', uniqueNames: ['A B', 'C D'],
    financialLines: fin, reviewNotes: null,
  });
  const got = buildCancellationEmail({
    flow: CANCELLATION_FLOW_REQUEST_APPROVED, isGroup: true, eventName: groupName,
    recipientName: 'Z', isBooker: false, bookingRef: 'GRP-1', ticketCount: 3,
    uniqueAttendeeNames: ['A B', 'C D'], reversalResults: groupReversal,
  });
  check('group-approved attendee body', expected, got.html);
}

// Group rejected, booker
{
  const expected = legacyGroupHtml({
    recipientName: 'Eve', isBooker: true, isApproved: false, eventName: groupName,
    ticketCount: 3, groupRef: 'GRP-1', uniqueNames: [], financialLines: [],
    reviewNotes: 'No way <x>',
  });
  const got = buildCancellationEmail({
    flow: CANCELLATION_FLOW_REQUEST_REJECTED, isGroup: true, eventName: groupName,
    recipientName: 'Eve', isBooker: true, bookingRef: 'GRP-1', ticketCount: 3,
    uniqueAttendeeNames: [], reversalResults: null, reviewNotes: 'No way <x>',
  });
  check('group-rejected booker body', expected, got.html);
  check('group-rejected subject', `Group Booking Cancellation Request Rejected — ${groupName}`, got.subject);
}

// Group rejected, attendee
{
  const expected = legacyGroupHtml({
    recipientName: 'Frank', isBooker: false, isApproved: false, eventName: groupName,
    ticketCount: 3, groupRef: 'GRP-1', uniqueNames: [], financialLines: [],
    reviewNotes: 'No way <x>',
  });
  const got = buildCancellationEmail({
    flow: CANCELLATION_FLOW_REQUEST_REJECTED, isGroup: true, eventName: groupName,
    recipientName: 'Frank', isBooker: false, bookingRef: 'GRP-1', ticketCount: 3,
    uniqueAttendeeNames: [], reversalResults: null, reviewNotes: 'No way <x>',
  });
  check('group-rejected attendee body', expected, got.html);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
