# Event waiting lists

Waiting lists record interest, not reservations. The event's Waiting List
toggle is independent of its timing/status and defaults off. Single-session,
multi-session and multi-day editors use the same boolean.

## Member and administrator paths

- Existing event details retain tickets, advertised prices and attendee input.
  Waiting mode replaces the payment component before its payment hooks mount.
  Members sign in before joining. Existing group self-registration and ticket
  audience restrictions remain; capacity and sale-release dates do not limit interest.
- `/waitingList` uses My Tickets RBAC. Members can remove their own entry;
  the original booker can also remove attendees they registered or explicitly
  withdraw the whole registration. Withdrawals retain an audit trail.
- Event Registration Report has a separate waiting-list section for a selected
  event. Waiting-list records never enter booking-based totals or awards.
- In the existing campaign editor select **Event waiting list** and events.
  Only active entries form this audience, and both batch and individual sends
  recheck active entries before provider submission. Existing consent and bounce
  controls still apply. This audience cannot be mixed with other types or
  nested inside saved audience lists. No automatic updates are sent on joining.

## Storage and rollout

Required migration: `supabase/migrations/20261205_event_waiting_lists.sql`.
It has **not been applied to a live database** as part of implementation.
Apply to approved DEST before deploying code that selects the new event flag.
SOURCE is not a rollout target.

Protected service-only registration/entry tables separate interest from every
booking/payment/CPD consumer. Transactional creation is idempotent and atomic for
all attendees; prices and session choices come from authoritative event data.
A database trigger also rejects new normal booking rows for waiting events.
Existing confirmed bookings remain unchanged if an event's mode changes.

Do not change an event's mode during an in-flight payment checkout. New payment
and booking entry points reject waiting mode; it does not cancel existing Stripe
payment intents, convert paid bookings, or provide a new payment-recovery policy.

No ranking, promotion, payment collection, conversion or automatic allocation is
included. Joining does not change general marketing consent.

## Verification

Use `scripts/run-isolated-tests.mjs --allow-local-postgres` for the dedicated
eventWaitingList backend/PostgreSQL suites and the frontend waiting-list tests.
The PostgreSQL suite creates an isolated temporary database; it never uses DEST
or the workspace database. Mounted checkout tests verify no normal booking or
payment call is made and ambiguous failures reuse the same attempt UUID.
Signed-in live pages and provider delivery still require post-deployment checks.
