---
name: Event email delivery ledger
description: How confirmation/reminder/follow-up sends are tracked and matched to Mailgun events, and rules to keep when adding new event email send paths.
---
Event emails are tracked per send attempt in a dedicated ledger, identified to Mailgun by the custom variable `iconn_event_email_delivery` (the ledger row id).

- Any new event email send path must go through the shared tracked-send wrapper, never call the mailer directly, or its sends become invisible in the stats.
- The webhook must check the event-email variable before campaign matching; the campaign email-only fallback would otherwise attribute event emails to a campaign. Campaign sync also skips these events.
- A local send error is ambiguous (timeouts may still be accepted); provider evidence overrides a send-side failure, but temporary failures never override delivery.
- Event emails force opens-only tracking per message (clicks explicitly off); click tracking would rewrite joining links.
- CC/BCC copies share the ledger variable: provider outcomes apply only when the event recipient matches the ledger recipient.
- Funnel confirmations carry both the funnel receipt and ledger variables; the webhook updates the ledger after the idempotent receipt, so a ledger failure can safely request a Mailgun retry.

**Why:** before this ledger, confirmation sends were unrecorded and reminder sends had no message ID, so failures were invisible.
**How to apply:** status writes go through the database functions only (service role has no direct UPDATE).

## Admin resend
- Resend is admin-triggered only and must never duplicate an attendee email: a persisted per-recipient lease must be taken (and eligibility re-checked under lock) before preparing a resend. History checks alone are raceable because the new ledger row only appears just before the provider call.
- A scheduled row still carrying the worker's claim marker may be mid-send or crashed mid-send; never re-queue it.

**Why:** duplicate sends to attendees are worse than a missed resend.
