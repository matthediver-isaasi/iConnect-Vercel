---
name: Event revenue basis
description: Business meaning and historical currency limitations of event revenue reporting.
---

Event revenue means booking value after discounts including unpaid invoices, allocated by event date—not cash received. Vouchers, training funds and account credit settle value rather than discount it again.

**Why:** The user explicitly selected booked value and event-date buckets; payment-based registration reports answer a different question.

**How to apply:** Preserve this distinction when extending measures or comparing reports. Refund-adjusted cash must be a separately named measure.

Legacy simple bookings may lack immutable currency evidence. Current linked ticket/event currency is an explicitly disclosed fallback, not proof of historical currency.

**Why:** Assuming GBP would silently misstate other currencies, while refusing all legacy simple bookings would make this source unusable for otherwise explicitly configured events.

**How to apply:** Prefer persisted financial snapshots; fail explicitly when neither snapshot nor linked configuration supplies currency. Future immutable snapshots should supersede, not silently reinterpret, this fallback.