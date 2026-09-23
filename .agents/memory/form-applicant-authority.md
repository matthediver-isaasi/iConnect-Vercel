---
name: Form applicant authority
description: Legacy public organisation applications require explicit scoped capabilities, not inferred ownership.
---

Public application links containing an organisation ID are reference/prefill
evidence, not permission to modify that organisation. Compatibility must preserve
configured finance/contact updates using server-issued, scoped applicant
authority rather than dropping the updates or trusting submitted emails.

**Why:** Existing organisation workflows sent bare-ID links for application forms
that really update finance and custom fields. Restoring those flows by treating
the link, draft, or generic processor signature as ownership would authorize
arbitrary existing-record changes.

**How to apply:** Keep issuance trusted and bind authority to the tenant, form,
organisation, configuration, and a single persisted submission. A draft must have
an independent server-recorded capability association. Any existing-member
authority must be an immutable issuance-time scope revalidated against current
organisation membership, never inferred from a newly submitted email. Previously
sent unauthenticated links need a replacement secure link or verified ownership;
they cannot be silently upgraded. Invitation admission expiry is distinct from
finalizing an already authorized immutable submission.