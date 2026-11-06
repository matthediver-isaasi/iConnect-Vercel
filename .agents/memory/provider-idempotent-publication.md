---
name: Provider idempotent publication
description: Why a losing reference-publication request must not cancel a shared provider intent.
---

When concurrent provider creates share an idempotency key, a reference-publication
loser may hold the exact same intent as the winner. Do not cancel that intent as
though it were an independently created losing payment.

**Why:** Adding provider idempotency to a legacy create-then-CAS flow changes the
meaning of “loser”; its compensating cancellation can invalidate the successful
request's payable intent.

**How to apply:** Whenever adding provider idempotency, audit publication-failure
compensation and unknown-reference recovery together. Retain uncertain holds
rather than assuming a missing local reference proves no provider effect.

Already-payable inventory reservations must recover using their immutable
checkout terms, not current catalogue eligibility or prices.

**Why:** A normal price edit or archive can otherwise strand the original intent
while an error encourages a second payable attempt and reservation.

**How to apply:** Verify same-key answers and reserved identity first; only new
attempts resolve current catalogue prices or availability.
