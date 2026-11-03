---
name: Zoom recovery approval
description: Registration diagnosis does not authorize live recovery or message sends.
---

Diagnose linked event Zoom registration read-only. Present provider evidence and obtain explicit confirmation before changing live registration settings, registering attendees or sending messages.

Personalised registration links do not guarantee that Zoom's post-meeting report exposes a registrant ID. Distinguish report connection records from unique identities.

**Why:** A live report contained repeat joins and account emails but no explicit registrant IDs; treating row counts as people or account IDs as registrant IDs would fabricate matches.

**How to apply:** Reconcile complete registration evidence; prefer explicit registrant IDs, retain exact-email fallback, and leave duplicate/conflicting identities for review. Never match by display name or claim unmatched evidence proves non-attendance. Unchanged recovered outcomes must not replay awards or workflows.

**Why:** The user explicitly separated diagnosis from recovery, including the implications for previously shared links and emails.

**How to apply:** Keep cached settings and historical success counts distinct from live provider evidence; an unavailable registrant list is not zero registrations. Provisioning creation controls and tenant-wide backfills are separately scoped work.

For registration-required Zoom events, confirmation and reminder emails must use
the recipient's approved personalised join link. Do not silently replace a missing
link with the general meeting URL. Attendee-selected email previews are read-only.

**Why:** The owner confirmed that generic links prompt existing attendees to
register again, which is unacceptable. A preview must let admins inspect real
attendee data without causing a registration or send.

**How to apply:** Resolve against live registration authority, suppress delivery on
lookup failure, and keep attendee links out of logs and shared caches. Clearly
distinguish sample previews from real attendee previews.
