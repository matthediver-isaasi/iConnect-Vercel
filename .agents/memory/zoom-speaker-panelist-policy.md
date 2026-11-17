---
name: Zoom speaker panelist policy
description: Automatic event-speaker synchronization, managed ownership and invitation-retry boundaries.
---
Attaching a webinar must synchronise the event's selected speakers as panelists;
saved speaker additions, removals and contact changes must reconcile too,
including events created by duplication.

**Why:** The owner found that attaching a webinar handled attendees but left its
event speakers absent from the panelist list.

**How to apply:** Preserve panelists created manually in Zoom. Aggregate the
desired speaker identities for shared webinar references before removing any
managed entry. Track provider IDs and ownership, not just email matches.
Incomplete speaker or provider lists cannot authorize removals. If a provider
creation response is lost and a matching panelist subsequently exists, do not
resend an invitation or infer deletion authority; require ownership review.
Persist source changes and retries independently of an open browser. Verify the
deployed scheduler separately from the preview endpoint. Test-event invitations
need explicit approval because their speakers may be real people.
