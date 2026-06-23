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
Complex (multi-session) events are intentionally OUT of scope of this model.
