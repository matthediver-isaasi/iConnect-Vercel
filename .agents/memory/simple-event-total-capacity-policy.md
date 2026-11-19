---
name: Simple-event total capacity policy
description: Why historical event counters must not be treated as maximum capacities.
---

Historical simple-event seat counters have been mutated by both purchases and
cancellations. Neither the saved counter nor that counter plus today's bookings
establishes the owner's intended maximum.

**Why:** A read-only investigation found a saved counter whose meaning could
not be established from current booking counts. The owner explicitly excluded
speculative backfills and live booking/payment/message changes for testing.

**How to apply:** Keep legacy event behavior until an administrator explicitly
establishes a verified total. Seek owner confirmation before converting a cited
live event; use disposable database scenarios to prove arithmetic and races
without implying that the fixture maximum is approved for production.
