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

A replacement term requires accounting evidence for its full value, not merely
an invoice for the extra cash collected.

**Why:** A difference-only invoice cannot substantiate the new purchase's full
price or distinguish inherited paid value from new cash. It also loses the
source and destination revenue/tax classifications.

**How to apply:** Preserve the original purchase; explicitly transfer its unused
value to the new invoice. Separate transferable value from surplus returned or
issued as personal credit, retaining original tax totals to the penny.

Replacement lineage is not renewal lineage: never use `previous_term_id` for
an overlapping replacement term or rewrite the original signed dates to fit it.

**Why:** Rolling membership enforces adjacent dates for renewals and excludes
overlapping signed terms even after ordinary expiry. A replacement needs its
own protected retirement/application authority, including consumed checkout
reservations; a simplified test schema does not exercise those guards.

New financial protocols must not become available to an older deployed server
merely because a database migration has been applied.

**Why:** Liability-backed credit depends on matching issuance, redemption and
return handling; old code can create accounting side effects before discovering
that it cannot complete the new workflow.

**How to apply:** Require the supported server protocol at the privileged
execution boundary, keep legacy readiness closed, and ensure transaction-local
capabilities cannot leak into a pooled connection.

Carrying prepaid cash into a changed membership must preserve its accounting
classification or perform an explicit accounting reallocation.

**Why:** Reducing future collections alone can leave prepaid revenue assigned to
the old service's account or tax classification. Even two zero-VAT codes can
represent different tax treatments.

**How to apply:** Verify the original invoices' actual revenue and tax codes
against the destination treatment, rather than assuming current configuration
describes historical postings. Do not also issue spendable credit for value
already offset against future collections.

Immediate cancellation charges only for service already used, including unpaid
amounts for that service; unused future annual instalments do not remain payable.

**Why:** The owner explicitly selected “Charge only for service used”.

**How to apply:** Reconcile actual settled funding against verified delivered
service. Do not accelerate or keep collecting the unused annual balance.
Prepaid surplus still follows the existing cancellation credit/refund policy;
end-of-term cancellation remains a separate operation.

Immediate cancellation ends membership access immediately even when a
service-used balance remains unpaid. Keep that balance as outstanding debt;
paying it must not reactivate membership. Refund processing is separate too.

**Why:** The owner explicitly chose “Immediately; retain any unpaid balance”.
**How to apply:** Do not reuse the upgrade settlement-before-entitlement gate
for cancellation. Track access termination independently of accounting and
provider recovery, without treating an unconfirmed provider stop as successful.

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

External funding claims and whole-purchase credit release must serialize on the
same purchase authority. Recover an existing claim by reading accounting rather
than repeating a payment write.

**Why:** A compensation can otherwise restore spendable credit while a concurrent
or uncertain funding request still consumes its liability backing.

**How to apply:** Fence releases before provider calls and retain unresolved
claims until the accounting debit and any return have been reconciled.

A membership-credit provenance label alone is not proof of accounting backing.
Reserve that label for verified issuance and require its immutable backing record.

**Why:** Ordinary voucher creation must not manufacture apparently liability-backed
credit by selecting a funding-source label.

**How to apply:** Validate provenance on creation, reservation and accounting
funding, including imported or legacy rows whose labels have no backing record.

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

A verified pre-payment throttle or documented rejection of the actual funding POST may grant one delayed,
serialized retry; a throttle during subsequent readback is not that evidence.
Credit returns must require complete accounting for the affected collection,
not merely debit evidence from an earlier instalment.

**Why:** Blanket retry prohibition strands definitively rejected payments, while
blanket retry permission duplicates uncertain ones. Aggregate debit totals can
also conceal a later instalment whose accounting never finished.

**How to apply:** Capture write-stage outcomes, consume retry permission atomically,
and keep unknown outcomes read-only. Block credit restoration until the affected
collection and outstanding funding claims have verified accounting evidence.

Carrying already-paid service value through an unchanged-price monthly change
must not also issue wallet credit for the same value.

**Why:** Preserving the original remaining collection obligation already accounts
for that payment; issuing separate spendable credit would give it twice.

**How to apply:** Keep unchanged-price carry distinct from a financial settlement,
and preserve verified cash ownership and the original renewal boundary.

Replacement holds must cover upfront checkout reservations and direct history
writes as well as recurring billing agreements.

**Why:** Checking only the current purchase can allow a second payment path to
reserve the replacement interval after accounting starts. The final membership
insert then fails even though financial documents have already been issued.

**How to apply:** Use the same rolling-membership lock for admission and
application across all three paths. Retain holds through unknown provider
outcomes; a worker lease expiring is not authority to release a financial hold.

Cancellation debt reductions and spendable surplus need separate accounting
credit notes.

**Why:** Liability backing verifies the full, unallocated surplus note.
Combining unpaid-invoice reductions with cash surplus can leave an external
write successful but unverifiable by the backing/recovery contract.

**How to apply:** Fully allocate each debt-reduction note to its original
invoice. Use a separate surplus note for refunds or liability backing, with
the backing payment referencing that same surplus note.

Do not treat money first verified after cancellation as automatically
pre-cancellation, non-refundable prepaid value.

**Why:** The tenant's prepaid-value policy must not turn a late collection of
unused future instalments into retained revenue.

**How to apply:** Preserve verified payment identities at approval and verify
payment timing when evidence changes. Unknown timing requires financial review,
not an assumed zero balance or automatic forfeiture.
