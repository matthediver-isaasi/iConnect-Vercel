---
name: Count-based ticket availability & oversell guard
description: How standard-event ticket availability is derived from confirmed bookings, and why oversell needs a DB advisory-lock guard (not a stored decrement).
---

# Count-based ticket availability (standard events)

For standard one-off events, `event.pricing_config.ticket_classes[].available_count`
is a FIXED MAXIMUM (capacity), not a live remaining counter. Live availability =
`available_count - count(status='confirmed' bookings for that ticket_class_id)`.
Never mutate `available_count` to track sales. Group confirmed counts by
`ticket_class_id` only — class *names* drift over time and are not stable keys.
A null/absent `available_count` means unlimited.

**Why:** a stored "remaining" decrement double-counts on retries and is impossible
to reconcile against the real bookings; deriving from confirmed rows is the single
source of truth.

## Oversell protection requires a DB guard, not app-level checks
A read-then-insert check in the booking function is not safe under concurrency:
two checkouts both pass the pre-check, then both insert. The real guard is a
Postgres function taking a per-(event,ticket_class) advisory lock:
- PRE-CHECK (no booking ids): reject before doing work if already full.
- POST-VERIFY (pass the just-inserted booking ids): re-rank confirmed rows under
  the lock and DELETE the losing rows if they exceed the max — the caller then
  auto-refunds.
See `check_oneoff_ticket_capacity(p_event_id, p_ticket_class_id, p_requested,
p_booking_ids)` and its migration/runner under `scripts/apply-oneoff-ticket-capacity-guard.mjs`.

**How to apply:** any new path that creates confirmed event bookings (or a future
complex-event equivalent) must call the guard with both pre-check and post-verify,
and on sold-out follow the existing auto-refund pattern. Note the current sold-out
refund only reverses Stripe (matching the pre-existing no-bookings path) — vouchers
and training-fund balances are NOT reversed yet.

## Display/realtime
`api/public/event.js` enriches finite classes with `sold_count` + `is_sold_out`.
`client/src/hooks/useTicketAvailabilityRealtime.js` computes remaining from
confirmed counts and subscribes to booking INSERT/UPDATE/DELETE + event UPDATE.

## Complex (multi-session) events — same model
Complex events now use the identical count-based model. Key differences from the
one-off case:
- Capacity lives in its own table column `complex_event_ticket_class.available_count`
  (uuid id, `is_unlimited_tickets` flag), NOT in a JSON pricing_config. Confirmed
  counts come from `complex_event_booking` (status always 'confirmed'); its
  `ticket_class_id` is TEXT while the class id is uuid, so the guard matches
  `id::text = p_ticket_class_id`.
- Guard: `check_complex_event_ticket_capacity(...)` — same pre-check/post-verify
  contract, advisory-lock namespaced `'cx:'` so it never collides with the
  one-off lock. Migration + `scripts/apply-complex-event-ticket-capacity-guard.mjs`.
- The complex booking path still maintains the event-level stored
  `complex_event.available_seats` counter (that is a separate event-wide cap);
  only the per-ticket-class stored decrement was removed. The old
  `atomic_decrement_ticket_class_seats` RPC is no longer called from booking.
- `useComplexEventTicketAvailabilityRealtime` was reworked to subscribe to
  `complex_event_booking` (not the ticket_class table) and derive remaining from
  confirmed counts, mirroring the one-off hook.
