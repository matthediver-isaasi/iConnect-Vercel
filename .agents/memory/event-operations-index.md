---
name: Event operations
description: Index of event timing, booking lifecycle, attendance rewards and revenue evidence.
---

- [Per-attendee flags](attendee-flag-surfaces.md) — propagate flags across both booking types and every display/export surface.
- [Complex reminders](complex-reminders-per-day.md) — per-calendar-day deduplication.
- [Zoom session IDs](session-zoom-id-conventions.md) — external provider IDs versus local records.
- [Deleted event bookings](event-delete-booking-detach.md) — preserve detached bookings and event-name snapshots.
- [Simple timing invariants](simple-event-timing-invariants.md) — shared timing guards and stale schedule suppression.
- [Attendee counts](event-card-attendee-count-states.md) — secured counts and explicit unresolved/error states.
- [Speaker awards](speaker-award-timing-lifecycle.md) — assignment badges versus event-start vouchers.
- [CPD badges](event-cpd-badge-awards.md) — attendee identity, whole-config overrides and transactional outbox.
- [CPD points](event-cpd-points-ledger.md) — append-only signed evidence ledger.
- [Event revenue](event-revenue-basis.md) — booked value versus cash and historical evidence.
- [Ticket releases](ticket-release-boundaries.md) — new-purchase gates, existing allocations and DST ambiguity.

**Why:** Specialized event constraints remain discoverable without crowding the always-loaded memory index.

**How to apply:** Open the relevant topic before changing event booking, timing, rewards or reporting.