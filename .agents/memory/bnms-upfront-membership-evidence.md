---
name: BNMS upfront membership evidence
description: Operator-attested current membership establishment is distinct from verified invoice settlement and future billing authority.
---

Treat the BNMS upfront backfill as establishment of existing 2025–2026 memberships,
not creation of new or future commitments. The operator authorized assuming these
members paid, with manual corrections later; keep that attestation distinct from
provider-verified invoice evidence.

BNMS membership structure is always derived from the member custom field
`member_class`. The imported YM membership-type label is not a structure.

**Why:** The owner corrected a repair which displayed “Full Membership UK” as
though it were a configured structure.

**How to apply:** Resolve the configured structure through its member-class
selector. For administrator-approved reconstruction, distinguish that mapping
from proof of which configuration existed on the original payment date. Use
verified invoice amounts, not current structure prices, for historical payments.

An imported expiry is not the complete membership history when a later paid
membership invoice exists.

**Why:** A separately approved historical repair initially preserved a stale
imported expiry; the subsequent Xero check found a newer full membership payment.
The owner authorised reconstructing that individual's successor as 12 months.
The owner subsequently confirmed the reconstructed record displayed correctly,
using the member-class-selected structure and the verified Xero payment.

**How to apply:** Check later provider invoices before presenting an expired
legacy term as the member's latest entitlement. Keep confirmed payments separate
from operator-authorised duration and structure reconstruction. Do not extend
this individual's term approval to the wider unresolved cohort.

Historical BNMS Xero contacts do not consistently carry the imported YM account
number. A failed account-number lookup is not proof of missing invoices.

**Why:** Live investigation found many contacts through pinned historical invoice
numbers and email instead. Some nevertheless had a different non-empty legacy
account number, requiring identity review rather than automatic matching.

**How to apply:** Check invoice references and email as independent evidence, and
hold explicit account-number conflicts. Mixed event invoices may separately
itemise a year's membership: preserve the membership line amount, never copy the
whole event invoice total into membership cost. Paid invoice evidence alone
does not confirm coverage dates; cohort reconstruction still needs approval.

The operator explicitly approved establishing the reviewed current cohort with
unknown historical amounts and no invoice links where matching remained
unresolved. Do not interpret that approval as authority to link uncertain invoices
or infer prices later.

**Why:** Retained legacy records contain expiry/class but may lack commencement.
The operator explicitly rejected interpreting the repair as future membership
creation. A latest invoice can also be an upgrade balance rather than a full annual
price; the operator chose the latest invoice amount for the reviewed pilot.

**How to apply:** Preserve known expiry and unknown start separately. Do not infer
annual commencement, add billing consent, or mint successor terms to make the UI
show an existing membership. Continue excluding known DD evidence. Link only a
verified matching invoice; an operator's paid assumption is not permission to
relabel an unpaid provider invoice or associate an older invoice with a newer term.

Do not reinterpret ambiguous legacy short expiry dates as UK dates solely because BNMS is a UK tenant.

**Why:** The user confirmed that an investigated ambiguous legacy date was intentionally US month/day/year and that the corresponding December history expiry was correct.

**How to apply:** Verify source-specific date conventions before proposing data repairs. A short slash-form custom value and a long-form history date may represent the same intended day; their visual difference alone is not evidence of corruption.

An expiry-only upfront record may support an explicitly labelled expected renewal date of expiry plus one day, without establishing a successor commitment.

**Why:** The user approved this reporting projection even when the imported start date and historical structure are unknown. The earlier prohibition on inventing future commitments must not be misread as prohibiting clearly labelled read-only forecasts.

**How to apply:** Prefer a saved renewal date; otherwise derive from trusted persisted expiry. Keep expected renewal and uniquely matched next-structure information separate from scheduled collection evidence. Never use the projection itself to authorise billing or create memberships.

For payer-initiated form renewal, approved paid attestation and a separate explicit
operator-assigned renewal policy may support quoting the successor from known
expiry without filling in historical commencement. The attestation alone is not
cohort-wide renewal authority.

**Why:** The user requested a narrowly authorised legacy renewal path, while
forbidding invented commencement, historic prices, settlement and billing consent.

**How to apply:** Preserve historical unknowns and distinguish administrator-paid
attestation in the UI. Use the exact assigned schedule for new pricing, not a
label-matched replacement or default. Keep unassigned histories blocked and
retain shared form/worker payment ownership before any future provider effects.

A legacy expiry policy must not revoke access after a valid elected recurring
successor has activated with confirmed payment. A confirmed instalment is not
full annual settlement, but can establish the new plan's active membership.

**Why:** Annual-only expiry protection excludes recurring successors, so an
unchanged legacy login-disabling assignment can otherwise lock out a renewed
member at its old grace deadline.

**How to apply:** Bind protection to the persisted owner, predecessor election,
agreement and current term. Require actual activation and confirmed payment;
pending authorization alone gives no protection. Leave future access decisions
to the successor's lifecycle without rewriting the historical financial evidence.

For the reviewed nine BNMS legacy memberships expiring 23 September–1 October
2026 (five Full UK, two Student, one Associate UK and one Full Overseas), the user
selected 90-day grace for all nine, then login disabled, with no role changes.
This is a cohort-specific policy choice, not a change to every BNMS tier.

**Why:** The user explicitly selected the uniform policy rather than matching
current tier settings, including the differing overseas policy.

**How to apply:** Preserve historical dates, amounts and membership identity.
The user separately authorized implementation, validation and production
application for these nine records, including their narrowly scoped overseas
exception. That approval does not extend to newly flagged records, the shared
tier settings or the separate sandbox Direct Debit setup. Do not infer billing
consent or future commitments.

The user also explicitly approved applying the same 90-day grace, subsequent
login restriction if unrenewed, and no role change to the Junior Membership UK
record expiring 2 October 2026.

**Why:** This additional record was presented separately and the user selected
“Apply the 90-day policy.”

**How to apply:** Treat this as approval for that record only, not an automatic
policy for other newly flagged legacy memberships. Preserve history and pricing;
do not create charges or new memberships.

The operator approved the seven schedule mappings and uniform 90-day opening
and grace policy for the separately reviewed 72 unassigned legacy histories,
including all five Full Overseas exceptions, with login disabled if unrenewed
after grace and no role change. Exact cohort boundaries are recorded in
`reports/bnms-legacy-renewal-schedule-approval-2026-10-04.md`.

**Why:** The operator explicitly selected all seven cohorts and the policy for
all selected cohorts, including Full Overseas, in a review-only approval form.

**How to apply:** This is schedule/policy approval only. Obtain separate approval
before database writes; keep rollout disabled. Do not extend it to new records,
change shared overseas settings, infer historical financial evidence or add
recurring consent.