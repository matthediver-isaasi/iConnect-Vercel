---
name: Zoom recovery approval
description: Registration diagnosis does not authorize live recovery or message sends.
---

Diagnose linked event Zoom registration read-only. Present provider evidence and obtain explicit confirmation before changing live registration settings, registering attendees or sending messages.

Request `include_fields=registrant_id` explicitly from Zoom's meeting report API. Its default response omits registrant IDs even for registered attendees. Exclude `in_waiting_room` time from qualifying attendance.

**Why:** A live report's 96 rows comprised 49 in-meeting and 47 waiting-room connections, covering 43 email identities. Its headline count was 49, not 49 distinct people. The optional field flag exposed IDs missing from the default response.

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
