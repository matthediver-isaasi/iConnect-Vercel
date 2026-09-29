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

Deleting a capability's organisation must retain revoked, detached history.

**Why:** Removing consumed grants loses the evidence needed to reject delayed
processing. Draft associations must not silently become ordinary unbound drafts.

**How to apply:** Preserve consumed-submission and draft associations, reject
detached authority on already-bound processing, and enforce binding predicates
in the database too. Never retry live organisation deletion as verification:
the existing multi-step cleanup can have partial effects.

Explicit applicant policy can restore a legacy form's editable mutation contract
without changing its business mappings; the user confirmed this approach worked.

**Why:** A legacy public organisation form had real finance/custom updates but no
explicit policy. Enabling the scoped applicant contract allowed the user to
update the form without weakening record ownership checks.

**How to apply:** Obtain approval for the exact production policy change. Do not
equate a successful form edit with proof of anonymous applicant completion, or
apply organisation-scoped policy wholesale to member-only signup forms.

## Keep ordinary form setup based on existing settings
Use Require login and Save & Continue as the ordinary administrator concepts.
Do not introduce manual applicant invitations as the default workflow or ask for
a duplicate access-policy decision when normal settings determine it safely.

**Why:** The user explicitly rejected reinventing prefill and resume workflows
around staff-issued invitations. Security must support those workflows without
turning every form into an invitation-only application.

**How to apply:** Keep exceptional scoped invitations advanced and distinguish
per-invitation organisation selection from form-wide configuration. Preserve
record-owner checks and existing explicit policies; simplifying setup is not
approval to grant anonymous updates or change live form admission settings.