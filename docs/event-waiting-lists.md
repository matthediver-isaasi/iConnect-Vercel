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
Applied with owner approval to live DEST (`lvmzliemqnieeoruhkik`) on
2026-10-25. SHA-256:
`0aa857dae09dcab509f29b781962a9b0845dc228a15d65cba4427f71fc03bea6`.
SOURCE was unchanged. No migrations remain pending for this feature.
Code deployment remains a separate step.

Verified before commit: both protected tables have RLS enabled and no
anon/authenticated table grants; both registration/withdrawal operations
are service-only with pinned search paths. Both booking guards are enabled.
All existing events remain out of waiting-list mode; both new tables are empty.
Full-row fingerprints confirmed all 5,243 simple and 49 complex booking rows
were unchanged within the migration transaction. Post-commit REST reads
confirmed the API schema recognises both tables and both event flags.

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

## Guest imports

Administrative imports can retain guests without creating member accounts or
inventing a member booker. This is not public guest signup. The protected
`import_guest_event_waiting_registration` operation requires a confirmed,
tenant-owned source booking with names and email, a source-file hash, an actor
and an idempotency key. It currently supports standard waiting-list events with
one free interest ticket. Multiple/paid ticket choices require explicit review.

Guest records remain visible in the administrative waiting list and available
to explicitly selected waiting-list campaign audiences. They have no member
portal ownership or automatic account linkage. Joining/importing does not send
messages or run booking workflows. The original booking is never converted or
deleted. Withdrawal authorization uses null-safe comparisons so an absent booker
does not grant access to another member.

The guest-storage migration is
`supabase/migrations/202612090002_guest_waiting_list_import.sql`.
It was applied to live DEST on 2026-10-29 following owner approval.
`scripts/import-gfi-guest-waiting-list.mjs` is the source-hash-pinned import
runner; default execution rolls back and `--apply` commits. Replays perform
no additional imports and do not reinstate withdrawn entries.

## Verification

Use `scripts/run-isolated-tests.mjs --allow-local-postgres` for the dedicated
eventWaitingList backend/PostgreSQL suites and the frontend waiting-list tests.
The PostgreSQL suite creates an isolated temporary database; it never uses DEST
or the workspace database. Mounted checkout tests verify no normal booking or
payment call is made and ambiguous failures reuse the same attempt UUID.
Signed-in live pages and provider delivery still require post-deployment checks.
