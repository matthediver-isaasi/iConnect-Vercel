---
name: Annual membership renewal lifecycle
description: Durable boundaries between annual renewal policy, term continuity, recurring agreements, and expiry enforcement.
---

Annual renewal settings belong to the dated tier configuration snapshot and must not reuse monthly Direct Debit/card grace or arrears fields. A renewal term starts the day after the prior persisted term ends and runs for a full year whether payment is early or during grace.

**Why:** Recomputing from the payment date shortens or shifts the member's expected year sequence, while classifying recurrence from current UI choices can allow double payment against an existing monthly agreement.

**How to apply:** Resolve eligibility from persisted history/config and persisted billing agreements. Keep early paid terms scheduled until their start date. Expiry enforcement must skip successfully renewed terms, protect tenant admins and unrelated memberships, invalidate sessions only for policy-owned login disablement, and persist action provenance.

Renewal display windows use inclusive UTC date boundaries: fixed annual terms anchor at persisted expiry, rolling terms at the next-start/renewal date. Explicit zero days means only that anchor day, not an unlimited window. An attested expiry-only legacy row can support a read-only CTA using its uniquely resolved member structure, without inventing commencement or establishing a successor. Recurring reservations, overlapping/ambiguous evidence and missing policy settings must not enable the CTA.

Legacy expiry-only attestation is not authority to apply today's login, role or grace policy. Review can permit unrelated work to advance, but an unresolved review must continue gating health across subsequent invocations until authoritative policy is assigned and successfully handled.

**Why:** Advancing past a review row and resetting per-run errors can report a healthy continuation while the underlying access-policy decision remains unresolved.

**How to apply:** Keep the review identity durable independently of traversal position; missing history or failed reads cannot count as resolution. Do not clear monitoring failures by inventing dates or attaching a current policy.

An operator may explicitly approve a renewal/access policy for an expiry-only historical term without asserting that the member purchased that structure.

**Why:** Retrofitting the historical purchased configuration or commitment snapshot can imply invented commencement and financial commitments, and violate rolling-term completeness constraints.

**How to apply:** Keep the approved expiry policy in separate server-owned authority, validate its tenant/member/history/paid-expiry binding, and display it separately from the historical membership type and unknown purchase structure. Preserve all original financial and term fields.

Membership-form payment-method elections are for the successor term only. Upfront-to-DD must allow mandate authorization before commencement without collecting for already prepaid time. DD-to-upfront must preserve every current-term instalment, retry, arrears and accounting link; only competing successor collection is suppressed. Continuing DD consent must not become a compulsory manual annual renewal.

**Why:** The user explicitly requires simultaneous current-term obligations and a separately purchased future term, with authorization distinguished from settlement.

**How to apply:** Coordinate form and provider-worker reservations before external effects, preserve the old agreement unchanged, and display commencement separately from the provider's actual expected first collection date.

Enabling new payment elections must be coupled to deployment of the shared
database ownership contract, not merely the availability of new frontend code.
Unknown database failures must not be treated as an absent feature.

**Why:** A mixed deployment that exposes cross-method choices before both workers
share their reservation authority can create competing successor commitments.

**How to apply:** Keep rollout disabled until the database contract is installed
and all affected workers can use it; verify installed contracts and provider
evidence separately from disposable-database tests.

Cancelled payment retries must retain the original quote and provider identity;
use separate payment attempts rather than overwrite the original binding.
Unused reservation release must serialize with every child creator, and is
unsafe once any quote/agreement/history exists, regardless of elapsed time.

**Why:** A late provider callback or an in-flight creator can otherwise revive an
apparently abandoned checkout after a competing successor has been authorized.

**How to apply:** Require confirmed terminal provider evidence for a new payment
attempt, retain unresolved outcomes for reconciliation, and fence released
reservations at the database insert boundary as well as in the API.

Replacement payment authority must reach the installed history-settlement guard,
not just quote loading and provider binding. Pending renewal discovery must
follow persisted election/child links rather than the latest started history.

**Why:** A bound replacement can still be rejected during paid-history insertion;
and at commencement a pending successor becomes the newest started history while
its election still references the predecessor.

**How to apply:** Test real paid-history insertion and replay under the complete
migration chain, plus form re-entry after child persistence on and after
commencement. Keep the original quote/provider identity and paused-owner checks.