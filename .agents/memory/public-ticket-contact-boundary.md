---
name: Public ticket contact creation
description: Product boundaries for opt-in CRM contact creation from public-facing tickets.
---

Public-ticket contact creation is for both the explicit purchaser and attendees receiving enabled tickets, not just the first attendee. Typed organisation names are descriptive, not verified affiliations.

The option must be available for both Public Only and Members & Public tickets.

**Why:** The user explicitly requested support for both public-facing audiences.

**How to apply:** Preserve ordinary existing-member checkout without creating duplicate contacts or replacing roles; extend guest provisioning consistently across editor, save validation and checkout.

**Why:** The user explicitly requested contact creation rather than paid membership, automatic account activation, organisation access or marketing opt-in.

**How to apply:** Preserve guest purchase provenance, keep the provisioning role separate from ticket eligibility roles, disable login and directory visibility on new contacts, and never infer an attendee organisation from the buyer. Unpaid Invoice/PO and merely authorized payments must not create records. Replay must use purchase-scoped creation evidence, not adopt unrelated existing tenant/email records.

Keep historical email uniqueness indexes when strengthening normalization; reject
historical collisions rather than merging contacts automatically.

**Why:** JavaScript trimming includes whitespace that PostgreSQL's default
`btrim` does not. Removing the old uniqueness contract risks unrelated member
writers, while automatic deduplication would change existing members without
authorization.

**How to apply:** Treat a normalization-index migration conflict as an operator
decision and preserve all existing records.

Paid capacity-loss recovery must not depend on booking rows existing.

**Why:** A transaction can correctly roll back every booking after payment has
been captured. A recovery queue limited to purchases with bookings strands
those payments permanently.

**How to apply:** Record terminal capacity loss in the purchase authority,
distinguish it from transient database failure, and discover refund-pending
receipts independently. Refund retries require provider-bound evidence and an
idempotency key; a failed final audit write must not refund twice.

For ticket-contact rollout, the owner will deploy manually: do not push to
GitHub or auto-deploy. Sandbox testing was explicitly waived for this
functionality in favor of immediate owner-led live testing.

**Why:** The owner explicitly requested this release boundary.

**How to apply:** Hand off verified database readiness without claiming live
deployment or purchase verification. Do not initiate synthetic live purchases.
