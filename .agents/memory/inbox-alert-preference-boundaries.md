---
name: Inbox alert preference boundaries
description: Popup-only scope and authenticated-login authority for reversible alert settings.
---

The user agreed labels are “Hide alert until next login” and “Always hide alert”. These preferences must affect only the popup, never read state, badge counts, inbox access, email delivery or communication consent.

**Why:** Hiding a reminder is not a message action or a delivery/consent choice; the user explicitly kept those separate.

**How to apply:** Keep temporary suppression tied to the existing authenticated login, not tab storage or auth revalidation epochs. Re-enablement must ignore legacy message-watermark dismissals. Persistent hiding takes precedence, but both settings remain editable.

Displaying the alert must never count as acknowledgment. Preserve resolved popup preferences through ordinary refreshes, and distinguish explicit acknowledgment from historical display-only records.

**Why:** A background preference error or role-validation key change can remove an untouched dialog; a display-time suppression flag then prevents recovery even on reload. Historical records cannot distinguish that failure from a soft dismissal.

**How to apply:** Recover display-only records without erasing explicit hide choices. Keep failed explicit actions visible and retryable, and continue fencing all writes to the server-owned login.
