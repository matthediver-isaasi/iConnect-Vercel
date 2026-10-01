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