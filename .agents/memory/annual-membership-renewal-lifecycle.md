---
name: Annual membership renewal lifecycle
description: Durable boundaries between annual renewal policy, term continuity, recurring agreements, and expiry enforcement.
---

Annual renewal settings belong to the dated tier configuration snapshot and must not reuse monthly Direct Debit/card grace or arrears fields. A renewal term starts the day after the prior persisted term ends and runs for a full year whether payment is early or during grace.

**Why:** Recomputing from the payment date shortens or shifts the member's expected year sequence, while classifying recurrence from current UI choices can allow double payment against an existing monthly agreement.

**How to apply:** Resolve eligibility from persisted history/config and persisted billing agreements. Keep early paid terms scheduled until their start date. Expiry enforcement must skip successfully renewed terms, protect tenant admins and unrelated memberships, invalidate sessions only for policy-owned login disablement, and persist action provenance.

Renewal display windows use inclusive UTC date boundaries: fixed annual terms anchor at persisted expiry, rolling terms at the next-start/renewal date. Explicit zero days means only that anchor day, not an unlimited window. An attested expiry-only legacy row can support a read-only CTA using its uniquely resolved member structure, without inventing commencement or establishing a successor. Recurring reservations, overlapping/ambiguous evidence and missing policy settings must not enable the CTA.