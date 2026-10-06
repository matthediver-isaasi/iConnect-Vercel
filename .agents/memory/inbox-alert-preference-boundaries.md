---
name: Inbox alert preference boundaries
description: Popup-only scope and authenticated-login authority for reversible alert settings.
---

The user agreed labels are “Hide alert until next login” and “Always hide alert”. These preferences must affect only the popup, never read state, badge counts, inbox access, email delivery or communication consent.

**Why:** Hiding a reminder is not a message action or a delivery/consent choice; the user explicitly kept those separate.

**How to apply:** Keep temporary suppression tied to the existing authenticated login, not tab storage or auth revalidation epochs. Re-enablement must ignore legacy message-watermark dismissals. Persistent hiding takes precedence, but both settings remain editable.
