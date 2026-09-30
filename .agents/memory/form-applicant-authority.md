---
name: Form applicant authority
description: Legacy public organisation applications require explicit scoped capabilities, not inferred ownership.
---

## Explicit legacy exception approved by the user

The user explicitly accepted the disclosure risk of permanent organisation and
member IDs and requested restoration for public applications that previously
worked with those links. The scoped exception is `legacy_public_application`,
not global ownership and not the default for new forms. The two fixture-proven
forms are Partner Full Application and University Full Application in the GFI
tenant. The approved migration cohort additionally includes Freelancer membership,
PoC Join, Individual, Partner Individual Join, and HoS Join, whose current public
member/organisation prefill and active mappings establish the historical contract.
No-prefill forms remain unchanged. Preserve tenant validation and administrator-configured mappings; bind
the resolved targets to immutable server-owned submission scope for processing
and retries. Login-required forms and explicit secure invitation modes elsewhere
remain protected. Do not apply this mode to every public form simply because it
supports prefill. The migration must be reviewed/applied separately; code changes
alone do not change production access settings.

The rules below remain applicable outside that deliberately opted-in exception.

Legacy public admission must take precedence over stale secure-invitation state.

**Why:** Previously issued non-expiring links can carry a continuation marker
while a browser retains an expired invitation token; draft associations can
also outlive a form's switch to the approved legacy policy. Those credentials
must not silently reintroduce an invitation requirement.

**How to apply:** Ignore invitation credentials for explicitly approved legacy
public forms across viewing, drafts, submission and payment, retaining the
legacy tenant and configured-mapping checks. Keep secure-mode checks elsewhere.

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

Automatic setup may derive the existing applicant-continuation policy for a
compatible public organisation-update form; this is save-time configuration,
not authority for an arbitrary visitor.

**Why:** Requiring the administrator to select advanced access manually blocked
the normal trusted workflow-email application flow. Existing organisation
workflow emails can issue the scoped authority without applicant involvement.

**How to apply:** Validate the derived policy, preserve explicit policies and
runtime ownership checks, and never treat a bare organisation ID as permission.
Fixing Automatic save does not repair an already-sent or stripped email link.