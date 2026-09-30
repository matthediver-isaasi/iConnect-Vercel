---
name: Complex event reminders are per-day
description: Relative reminders for complex events are one per calendar day; dedupe reuses session_id as the deterministic day-anchor session.
---

Relative reminders for complex (multi-day) events are scheduled ONE PER CALENDAR DAY (event timezone, UTC fallback), anchored to the earliest session that day the ticket class can access. Three paths schedule them (internal function, public booking flow, bulk reschedule on email-settings save) — all must share the same per-day logic or they drift back to per-session duplicates.

**Why:** per-session scheduling spammed attendees with duplicate same-day reminders, and one drifted copy queried sessions by the wrong FK and scheduled nothing.

**How to apply:** the `scheduled_email` unique key stays `(event_email_id, booking_id, session_id)` with the day's anchor session as `session_id`; the anchor is deterministic so re-runs dedupe without a schema change. Absolute (specific datetime) reminders stay once per booking with `session_id NULL`. Never make the anchor choice non-deterministic.
