---
name: Member activity chronology
description: Historical renewal invoices belong in the member's chronological Activity timeline.
---

Historical invoices, including membership renewal invoices, should appear alongside other member activities in chronological order, rather than in a separate archive above the timeline. Use the invoice's own date and the event's actual date, not the import or record-creation timestamp.

**Why:** The user identified that historical imports make creation-date ordering misleading and explicitly requested a combined timeline for better UX.

**How to apply:** Preserve original historical evidence and invoice permissions. Do not treat a historical invoice as current membership entitlement or invent a renewal date from its import timestamp.

Current and recovered membership invoices belong in the same Activity timeline, not only the Membership tab.

**Why:** The owner expected a newly recovered paid membership invoice to be visible in Activity; an archive-only timeline incorrectly looked incomplete.

**How to apply:** Deduplicate linked invoices against imports. Do not invent a provider invoice date when only payment or membership dates are stored: label the available date explicitly and never use recovery time as the original occurrence.
