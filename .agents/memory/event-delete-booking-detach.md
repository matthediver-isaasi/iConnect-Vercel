---
name: Event hard-delete vs booking rows
description: How delete-with-cancellations survives booking FK/NOT NULL constraints and keeps history readable
---

The event delete-with-cancellations flow hard-deletes the event row while cancelled booking rows persist.

**Rules:**
- `booking.event_id` was both FK'd (`booking_event_id_fkey`, now ON DELETE SET NULL) **and NOT NULL** — SET NULL alone is useless without dropping the NOT NULL. Both were fixed in DEST (`supabase/migrations/20260804_booking_event_delete_resilience.sql`). `complex_event_booking.event_id` has NO FK to complex_event at all.
- Before deleting the event row, the shared deletion helper snapshots `event_name` onto every booking row and clears `event_id` — deliberately NOT tenant-filtered, so stray NULL-tenant rows can't block anything.
- The snapshot column is named `event_name` (not event_title) because client surfaces (History.jsx, Bookings.jsx, EventRegistrationReport.jsx) already fell back to `booking.event_name`.
- Any server surface resolving an event title from a booking/cancellation-request must fall back to `booking.event_name` when the event row is gone (cancellation-requests GET + both notification-email paths do this).
- Selects naming `event_name` use the 42703 drop-and-retry pattern because the stale SOURCE db (workspace runtime) lacks the column.

**How to apply:** any new surface joining bookings→event must tolerate NULL event_id + use the event_name fallback; any new booking-like table referencing an event should be nullable or ON DELETE SET NULL from day one.
