---
name: Event waiting-list policy
description: Interest-only scope, shared My Tickets access and payment/report separation.
---

Waiting lists express interest, never reserve a place. Support members and
colleagues across all event types, retaining advertised prices and choices.
Use My Tickets permissions, not a new permission.

Owner-approved historical guest imports may exist without a member booker or
attendee account. Do not create accounts, invent an administrator as booker, or
automatically attach a later matching member to make these records fit the
member self-service flow. Historical confirmed bookings stay unchanged.

**Why:** The owner explicitly approved importing unmatched guest interest while
prohibiting downstream emails and flows. Import permission is not public guest
signup, account creation, historical conversion, or new ownership authority.

**How to apply:** Retain source evidence, import identity and idempotency; treat
null owners as no access using null-safe permission comparisons. Import only to
interest storage; any later ownership or booking conversion needs separate scope.

**Why:** The owner's brief explicitly excludes ranking, promotion, allocation,
automatic conversion and payment collection.

**How to apply:** Reuse selection UI, but keep interest records separate from
booking/payment/attendance consumers. Withdrawal must remove eligibility from
prepared communications too, without changing unrelated bookings or marketing
consent. Preserve explicit individual versus whole-registration withdrawal.

On event cards, waiting-list mode replaces the attendee metric with active people/entries, not registration groups. The administrative list follows existing event-attendee viewing permissions; My Tickets keeps its separate member permission.

**Why:** The owner wants one card action reflecting the event's current mode, without adding permissions or treating interest as a booking.

**How to apply:** Preserve this distinction when extending counts, exports or administrative actions. Booking mutations must never accept waiting-list entries.
