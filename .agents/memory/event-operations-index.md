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
- [Import batches vs purchases](import-batch-vs-purchase-group.md) — batch provenance must not group unrelated attendees under an inferred booker.
- [Speaker awards](speaker-award-timing-lifecycle.md) — assignment badges versus event-start vouchers.
- [CPD badges](event-cpd-badge-awards.md) — attendee identity, whole-config overrides and transactional outbox.
- [CPD points](event-cpd-points-ledger.md) — append-only signed evidence ledger.
- [Issued CPD certificates](issued-cpd-certificate-policy.md) — retain completed PDFs independently of templates; capture time is not historical delivery evidence.
- [Certificate text recovery](certificate-authored-text-recovery.md) — example wording is not recovery evidence; schema repair and guarded restoration are separate.
- [Event follow-up policy](event-follow-up-policy.md) — day and overall-event ends use full programme completion, not recipient-specific final sessions.
- [Event revenue](event-revenue-basis.md) — booked value versus cash and historical evidence.
- [Ticket releases](ticket-release-boundaries.md) — new-purchase gates, existing allocations and DST ambiguity.
- [Email editing boundary](event-email-edit-policy.md) — saving confirmation or reminder messages must never trigger a send or resend.
- [Attendee title policy](attendee-title-policy.md) — booking requirements must not become profile requirements or historical backfills.
- [Waiting-list policy](event-waiting-list-policy.md) — interest only, shared My Tickets access, no financial or confirmed-booking side effects.
- [Speaker audiences](event-speaker-audience-policy.md) — linked member email is authoritative; ad-hoc speakers stay external and normal consent applies.
- [Training agenda timezones](training-agenda-timezone-policy.md) — event-zone wall clocks; reject DST gaps/overlaps until occurrence choices can be persisted.
- [Training reminder delivery](training-reminder-delivery-policy.md) — per-entry scope, elapsed offsets, explicit existing-booking scheduling and unknown delivery outcomes.
- [Event display timezones](event-display-timezone-policy.md) — audience timezones are display-only; scheduling and date-only agendas stay unchanged.
- [Zoom recovery approval](zoom-recovery-approval.md) — read-only diagnosis is not permission for live registration changes or message sends.
- [Survey invitations](event-survey-invitation-policy.md) — attendance gates individual invitations; untracked events require warning and acknowledgement.

**Why:** Specialized event constraints remain discoverable without crowding the always-loaded memory index.

**How to apply:** Open the relevant topic before changing event booking, timing, rewards or reporting.