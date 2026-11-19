---
name: Unified booking invoice policy
description: Owner-approved replacement policy for new member and non-member event purchases; historical authority is preserved.
---

New event purchases must use a unified membership-based booking/invoice flow,
not GFI/BNMS-specific customer policies. Verified members may choose self,
eligible organisation, or direct/organisation-linked trust/group as accounting
customer independently of payment method. Self always remains available.
Unauthenticated email does not establish membership authority.

**Why:** On 2026-11-19 the owner explicitly superseded the earlier
organisation-first proposal, proposed guest toggle, and new public-PO manual
approval/member prerequisite.

**How to apply:** Non-member invoices belong to the booker. Organisation text is
optional reference information, never an automatic record or relationship.
Ticket policy controls optional member creation separately from guest access;
new-flow automatic creation has no organisation relationship. Preserve separately
authorised manual conversion. New public Invoice/PO generates an unpaid invoice
automatically after registration, without member creation or admin approval.
Free/fully credit-funded bookings remain outside invoicing.

Confirmed registrations must survive accounting/provisioning failures, with
durable review/retry evidence. Freeze original customer, provider company,
payment, amount, tax and ticket-policy instructions; conversion and retries
must not remap the purchaser or create replacement charges/invoices.

**Why:** Customer, attendee, booker, allocation and funding ownership are distinct;
post-confirmation accounting errors are not authority to undo registration.

**How to apply:** Version the new flow and enable only after schema/readers/workers
are ready. Historical record-only public PO, old approvals, pending attempts and
queued work retain their original authority. This policy is not permission for
historical rewrites, live financial tests or unapproved migration rollout.

Billing compatibility tests must include the actual older database guards and
provider capture migrations, not only a simplified booking schema.

**Why:** A standalone transaction fixture can pass while omitting a legacy
purchaser-context trigger or delayed-capture restriction that still rejects the
real new-flow path.

**How to apply:** Rehearse related migrations in order, keeping historical
approval/provenance restrictions in place. Distinguish that local evidence from
replaying an approved target's complete actual schema.

The payment's immutable provider metadata, not the browser's requested version,
determines whether unified contract authority is required. Apply the same
ownership rule to rejection/refund handling and early booking replay.

**Why:** A new payment can otherwise be submitted through a versionless legacy
route, bypassing its frozen customer or authorising someone else's compensation.

**How to apply:** Require the original server-owned tenant/source/event/purchaser
contract and bound payment before accepting or compensating a unified payment.
An absent request version must never downgrade that authority.
