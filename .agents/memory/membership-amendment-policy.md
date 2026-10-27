---
name: Mid-term membership amendment policy
description: Approved scope and financial treatment for changes during an existing membership.
---

Self-service changes and cancellation must be explicit opt-ins on existing
membership payment forms, sharing the administrative amendment engine rather
than creating a competing payment flow. Support both remaining-term and
replacement-term policies, with safe tenant-controlled approval/credit/refund
handling. Existing application forms must retain their behaviour unless enabled.

**Why:** The owner's self-service brief requires actual settled-value accounting,
preserved history and no duplicate collections or premature entitlement changes.

**How to apply:** Resolve the current purchase from authenticated membership
records, not form answers; revalidate eligibility and finances at confirmation.
Cancellation of access, renewal, collections and mandates are separate actions.
Never convert organisation-funded value into personal credit automatically.

New surplus credit from membership changes has tenant-configurable expiry,
defaulting to no expiry.
**Why:** The owner explicitly selected this policy.
**How to apply:** Keep newly issued surplus separate from reversals of previously
used vouchers; returning an existing voucher must preserve its original expiry.

Expired membership-change credit requires manual accounting review. Expiry
stops spending but must not automatically write off its remaining liability.

**Why:** The owner explicitly selected manual accounting review.

**How to apply:** Preserve the remaining accounting liability and its evidence
for finance review; do not invent a write-off account or automatically recognise
income when a credit expires. No-expiry credit does not enter expiry review.

New surplus is iConnect-only member credit backed by liability accounting,
not a simultaneously spendable accounting credit note.

**Why:** The owner explicitly chose iConnect credit with liability accounting.
Issuing an independent voucher while retaining a spendable accounting credit
note would expose the same surplus twice.

**How to apply:** Require a configured tenant liability account, verify that
issuance and redemption use that same account, and do not release usable credit
until its accounting backing and membership application are committed safely.

A cash-provider refund does not prove that the corresponding voucher-clearing
payment was reversed in accounting.

**Why:** The existing cash-refund path can restore voucher value independently
of its accounting entries. For liability-backed credit, that could restore
spendable value without restoring its liability backing.

**How to apply:** Verify redemption and return accounting as well as original
issuance before enabling liability-backed member credit. Preserve ownership and
expiry; unresolved return accounting must not silently create available credit.

For variable-monthly membership changes, service used is measured against
membership-start anniversaries, not scheduled or actual collection dates.

**Why:** The owner explicitly chose membership-start anniversaries for unused-value
calculations. Changing a collection day or collecting late must not redefine the
service period and therefore the credit or refund.

**How to apply:** Anchor each monthly boundary independently to the original
membership start, clamping month-end anniversaries. Keep the collection calendar
separate, use evidenced prices for the corresponding service periods, and never
infer settled cash from a due or submitted collection.

The user approved mid-current-term membership structure/tier changes with
additional-payment collection, retained credit notes and cash refunds all
covered, plus explicit membership-change history. Preserve the existing expiry
by default and prorate the difference over the remaining term.

**Why:** Changing a member's pricing override alone does not settle their
purchased membership. The user approved the proposed amendment plan.

**How to apply:** Preserve original purchase evidence and link amendments to it.
Do not describe fixed monthly card subscriptions or all Direct Debit agreements
as automatically repriced. Provider changes, settlement and entitlement
application must be coordinated, with unresolved outcomes visible rather than
treated as completed. A preview or pending request is not an applied change.

An administrator starting a new individual term must make an explicit purchase
choice; imported membership class or expiry alone is not a prior paid commitment.
Do not reuse a fee link that recalculates another structure instead of preserving
the administrator's chosen structure and commencement.

**Why:** Members without recorded purchase history need a new-purchase route,
not fabricated history to unlock amendments; existing fee links may recalculate
from current matching rules.

**How to apply:** Admin creation reserves the selected purchase and a member
authorisation link; it never supplies recurring consent or starts collection on
the member's behalf. Offer structure-enabled payment methods. Recover ambiguous
creation from saved purchase authority rather than generating a fresh quote or
payment request. Dynamic Direct Debit preserves initial evidence and the agreed
repricing policy, not a fictional guaranteed total for all future collections.

Direct member-page links can have valid authenticated member data while the
admin-dashboard tenant selector remains unset.

**Why:** A start-membership panel gated solely on that selector disappeared
entirely on a tenant-host direct link, even though adjacent finance panels loaded.

**How to apply:** Use the loaded member's tenant when the selector is absent;
preserve explicit selector precedence and server mismatch checks. Missing tenant
context should produce an explanation, not silently hide the action. Test the
real parent page's context handoff as well as the isolated panel.

Production schema parity must be verified before extending financial guards:
member and organisation history do not share all ownership columns, and a
canonical migration file does not prove its RPC was deployed.

**Why:** A disposable fixture with both owner columns hid an invalid member-table
constraint, and the live database lacked a manual-approval prerequisite.

**How to apply:** Inspect actual column ownership and function signatures read-only,
use realistic fixtures, and preserve atomic rollback on unknown migration drift.

Admins may either choose a payment method explicitly or let the member choose
from the selected schedule's enabled self-service methods.

**Why:** The owner requested both workflows; an administrative selection must
not force every new member into a single rail, and allowing choice must not
permit duplicate payment arrangements.

**How to apply:** Preserve each offered method's quote and collection policy.
Bind one method atomically before provider setup, retain the member's own consent
step, and never treat the method selection itself as payment.

Durable approval must precede a monthly provider mutation, and an ambiguous
provider or email outcome must not authorize an automatic replacement write.

**Why:** A provider can accept a change before the response is lost. Recording
approval only afterwards can strand an already-changed agreement, while
repeating the call or email can duplicate an externally accepted operation.

**How to apply:** Commit approval with the write claim, reconcile claimed
operations read-only, and commit entitlement application, collection-hold
release and notification scheduling together. Unknown email acceptance requires
review rather than an automatic resend.
