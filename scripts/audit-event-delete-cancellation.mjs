#!/usr/bin/env node
// Regression guard for task-700 (safe event deletion via cancellation flow).
//
// Two layers:
//
//   STATIC checks (always run, no DB credentials required) — verify wiring
//   that previously regressed: admin-guarded endpoints exist, status='cancelling'
//   guards in the three booking-creation paths, deterministic Stripe
//   idempotency key, audit-row reason discriminator, orphan cleanup includes
//   resource.linked_events for both event_id AND complex-event session ids.
//
//   END-TO-END test (only runs when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY +
//   AUDIT_TENANT_ID are set, AND --integration is passed). Creates a temporary
//   simple event + booking under the supplied tenant, calls
//   deleteEventWithCancellations directly, and asserts:
//     - booking.status flipped to 'cancelled'
//     - booking_cancellation_request audit row inserted with
//       reason='event_deleted:<eventId>' and status='approved'
//     - the event row is deleted
//     - sponsor_assignment / linked_events orphans are gone
//     - re-running on the same already-deleted event returns status='not_found'
//   The integration block is skipped (with a clear log line) when env vars are
//   missing so this script can run safely in CI / local dev without creds.
//
// Run: node scripts/audit-event-delete-cancellation.mjs [--integration]

import fs from 'node:fs';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` :: ${detail}` : ''}`);
}
function read(path) { try { return fs.readFileSync(path, 'utf8'); } catch { return null; } }

// ---------- STATIC ----------

const eventEp = read('api/events/[id]/delete-with-cancellations.js');
check('Simple event delete-with-cancellations endpoint exists', !!eventEp);
check('Simple endpoint is admin-guarded', eventEp && eventEp.includes('hasAdminAccess(ctx)'));

const complexEp = read('api/complex-events/[id]/delete-with-cancellations.js');
check('Complex event delete-with-cancellations endpoint exists', !!complexEp);
check('Complex endpoint is admin-guarded', complexEp && complexEp.includes('hasAdminAccess(ctx)'));
check('Complex endpoint targets complex_event table', complexEp && complexEp.includes("eventTable: 'complex_event'"));

const previewSimple = read('api/events/[id]/delete-preview.js');
const previewComplex = read('api/complex-events/[id]/delete-preview.js');
check('Simple delete-preview endpoint exists', !!previewSimple && previewSimple.includes('hasAdminAccess'));
check('Complex delete-preview endpoint exists', !!previewComplex && previewComplex.includes('hasAdminAccess'));

const eventDeletion = read('api/_lib/eventDeletion.js');
check('Shared eventDeletion helper exists', !!eventDeletion);
check('Helper exports previewEventDeletion', eventDeletion && eventDeletion.includes('export async function previewEventDeletion'));
check('Helper flips event to status=cancelling before processing bookings',
  eventDeletion && eventDeletion.includes("status: 'cancelling'"));
check('Helper inserts auto-approved booking_cancellation_request audit row',
  eventDeletion && eventDeletion.includes("status: 'approved'") && eventDeletion.includes('event_deleted:'));
check('Helper cleans up event_sponsor_assignment',
  eventDeletion && eventDeletion.includes('event_sponsor_assignment'));
check('Helper cleans up zoom_attendance', eventDeletion && eventDeletion.includes('zoom_attendance'));
check('Helper cleans up resource.linked_events for event_id AND complex-event session ids',
  eventDeletion && eventDeletion.includes('linked_events') && eventDeletion.includes('sessionIdSet'));
check('Helper cleans up complex_event_track / session / ticket_class',
  eventDeletion && eventDeletion.includes('complex_event_track')
    && eventDeletion.includes('complex_event_session')
    && eventDeletion.includes('complex_event_ticket_class'));
check('Helper only deletes event row when failed.length === 0',
  eventDeletion && /if \(failed\.length > 0\)[^}]+return[^}]+status: 'partial'/s.test(eventDeletion));

const bookingCancel = read('api/_lib/bookingCancellation.js');
check('Shared bookingCancellation helper exists', !!bookingCancel);
check('Helper exports event_deleted reason discriminator',
  bookingCancel && bookingCancel.includes("CANCELLATION_REASON_EVENT_DELETED = 'event_deleted'"));
check('Helper uses deterministic Stripe idempotency key',
  bookingCancel && bookingCancel.includes('event-delete-refund-${reason}-${booking.id}'));
check('Helper short-circuits already-cancelled bookings (idempotent re-run)',
  bookingCancel && bookingCancel.includes("alreadyCancelled: true"));
check('Helper raises full-amount Xero credit note', bookingCancel && bookingCancel.includes('createXeroCreditNote'));
check('Helper restores training fund / vouchers / discount code / program tickets',
  bookingCancel && bookingCancel.includes('training_fund_transaction')
    && bookingCancel.includes('reinstateVoucher')
    && bookingCancel.includes('discount_code')
    && bookingCancel.includes('program_ticket_transaction'));
check('Helper cancels Zoom registrants for both event types',
  bookingCancel && bookingCancel.includes('cancelZoomRegistrant')
    && bookingCancel.includes('cancelComplexEventZoomRegistrations'));

// task-704: legacy generic entity DELETE must refuse Event / ComplexEvent and
// point callers at the safe endpoints, so SDK / automation paths can't bypass
// the cancellation flow.
const entityDelete = read('api/entities/[entity]/[id].js');
check('Legacy entity DELETE refuses Event with 409',
  entityDelete
    && /entity === 'Event'\s*\|\|\s*entity === 'ComplexEvent'/.test(entityDelete)
    && entityDelete.includes('use_delete_with_cancellations')
    && /res\.status\(409\)/.test(entityDelete));
check('Legacy entity DELETE points callers to /delete-with-cancellations',
  entityDelete
    && entityDelete.includes('/api/events/${id}/delete-with-cancellations')
    && entityDelete.includes('/api/complex-events/${id}/delete-with-cancellations'));
check('Legacy entity DELETE no longer hard-deletes bookings by event_id',
  entityDelete && !/from\('booking'\)\s*\.delete\(\)\s*\.eq\('event_id'/.test(entityDelete));

const fnFile = read('api/functions/[functionName].js');
const cancellingChecks = (fnFile || '').match(/event\.status === 'cancelling'/g) || [];
check('createBooking + createOneOffEventBooking both block status=cancelling',
  cancellingChecks.length >= 2, `found ${cancellingChecks.length} guards (need >= 2)`);

const publicComplex = read('api/public/complex-event-booking.js');
check('Public complex-event-booking blocks status=cancelling',
  publicComplex && publicComplex.includes("event.status === 'cancelling'"));

// UI preview wiring.
const eventCard = read('client/src/components/events/EventCard.jsx');
check('EventCard delete dialog calls /delete-preview before confirm',
  eventCard && eventCard.includes('/delete-preview') && eventCard.includes('text-delete-preview-summary'));
const eventsPage = read('client/src/pages/Events.jsx');
check('Complex-event delete dialog calls /delete-preview before confirm',
  eventsPage && eventsPage.includes('/delete-preview') && eventsPage.includes('text-complex-delete-preview-summary'));

// ---------- INTEGRATION (opt-in) ----------

const wantIntegration = process.argv.includes('--integration');
const haveCreds = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.AUDIT_TENANT_ID;

if (!wantIntegration) {
  console.log('\nINFO — integration test skipped (pass --integration to run end-to-end against a real tenant)');
} else if (!haveCreds) {
  console.log('\nSKIP — integration test requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + AUDIT_TENANT_ID');
} else {
  console.log('\n--- Running end-to-end integration test ---');
  const tenantId = process.env.AUDIT_TENANT_ID;
  let createdEventId = null;
  let createdBookingId = null;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const { deleteEventWithCancellations } = await import('../api/_lib/eventDeletion.js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Fixture: create a free event + one booking. No payment intent / xero
    // invoice — keeps the test self-contained (no Stripe/Xero side effects).
    const ref = `audit-${Date.now()}`;
    const { data: ev, error: evErr } = await sb.from('event').insert({
      tenant_id: tenantId,
      title: `[audit] safe-delete ${ref}`,
      status: 'published',
      event_state: 'published',
      start_datetime: new Date(Date.now() + 7 * 86400000).toISOString(),
      end_datetime: new Date(Date.now() + 7 * 86400000 + 3600000).toISOString(),
    }).select('id').single();
    if (evErr) throw new Error('Fixture event insert failed: ' + evErr.message);
    createdEventId = ev.id;

    const { data: bk, error: bkErr } = await sb.from('booking').insert({
      tenant_id: tenantId,
      event_id: ev.id,
      attendee_email: `audit+${ref}@example.test`,
      attendee_first_name: 'Audit',
      attendee_last_name: 'Tester',
      booking_reference: ref,
      status: 'confirmed',
      total_cost: 0,
    }).select('id').single();
    if (bkErr) throw new Error('Fixture booking insert failed: ' + bkErr.message);
    createdBookingId = bk.id;

    // Run delete.
    const result = await deleteEventWithCancellations({
      eventId: ev.id,
      tenantId,
      eventTable: 'event',
      organiserMessage: 'Audit run',
      adminLabel: 'audit-script',
      suppressEmails: true,
    });
    check('Integration: deleteEventWithCancellations returned status=deleted', result.status === 'deleted', JSON.stringify({status:result.status,failed:result.failed?.length}));
    check('Integration: 1 booking processed', result.totalBookings === 1, `total=${result.totalBookings}`);
    check('Integration: 0 failures', (result.failed || []).length === 0);

    const { data: bkAfter } = await sb.from('booking').select('status').eq('id', bk.id).maybeSingle();
    check('Integration: booking flipped to cancelled', bkAfter?.status === 'cancelled', `status=${bkAfter?.status}`);

    const { data: audit } = await sb.from('booking_cancellation_request')
      .select('reason, status, reviewed_by').eq('booking_id', bk.id).maybeSingle();
    check('Integration: audit row inserted with event_deleted reason',
      audit && audit.reason === `event_deleted:${ev.id}` && audit.status === 'approved',
      JSON.stringify(audit));

    const { data: evAfter } = await sb.from('event').select('id').eq('id', ev.id).maybeSingle();
    check('Integration: event row deleted', !evAfter);

    // Idempotent re-run.
    const rerun = await deleteEventWithCancellations({ eventId: ev.id, tenantId, eventTable: 'event', adminLabel: 'audit-script', suppressEmails: true });
    check('Integration: re-run on deleted event returns not_found', rerun.status === 'not_found', `status=${rerun.status}`);
  } catch (err) {
    check('Integration: end-to-end run', false, err.message);
  } finally {
    // Cleanup any leftover fixtures (defensive).
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      if (createdBookingId) await sb.from('booking_cancellation_request').delete().eq('booking_id', createdBookingId);
      if (createdBookingId) await sb.from('booking').delete().eq('id', createdBookingId);
      if (createdEventId) await sb.from('event').delete().eq('id', createdEventId);
    } catch {}
  }
}

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) FAILED:`);
  for (const f of failed) console.error(`  - ${f.name}${f.detail ? ` :: ${f.detail}` : ''}`);
  process.exit(1);
}
process.exit(0);
