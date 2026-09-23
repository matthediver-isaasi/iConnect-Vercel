---
name: Financial exception evidence
description: Preserve full provider evidence behind exact financial-exception approvals.
---

Preserve a private immutable full provider response alongside the canonical digest whenever approving or renewing a financial exception.

**Why:** A digest plus amount summary cannot explain a later mismatch. Provider timestamps, optional fields and array order can change a digest without proving a business change; a mutable checkpoint may overwrite the only approved baseline.

**How to apply:** Use the same canonical hashing function as the release guard, retain both reviewed and observed snapshots privately, and compare actual fields before describing a mismatch as a changed invoice. Never weaken the exact approval guard or assume unchanged amounts prove the whole evidence is unchanged.

Fetch comparison evidence through the same provider query shape as the canonical readiness reader.

**Why:** Xero invoice-by-ID and contact/date-filtered invoice listing returned different response representations for the same unchanged invoice. The canonical listing matched the existing approval exactly; the alternate query falsely appeared to invalidate it.

**How to apply:** Match endpoint, filters, ordering and pagination before comparing digests. A convenient alternate lookup is not interchangeable evidence.

## Exact BNMS Alpha operator exception (applied 2026-09-23)

- This was a **one-off, explicit user approval**, independently reviewed before apply, for exactly 249 adopted Alpha members under manifest `3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a`. It is **not blanket permission for future exceptions**, other cohorts, financial mutations, or stale evidence.
- Only **fresh Xero checks** and **deployment-report freshness** were waived. Identity, ownership, active mandate, pricing, payment/subscription duplication, exact deployed source, schema and the October-1 gate remained mandatory. Xero received no API requests. The normal release pathway remains strict.
- Actual apply reacquired account-wide GoCardless evidence (20 GETs, 2026-09-23 12:27:26.580–12:27:41.279Z), refreshed non-Xero DEST checks, and used the original Alpha advisory transaction lock/CAS and immutable release guards. All seven runtime source hashes matched the supplied deployed commit; no migration/runtime change was needed.
- 249 immutable release rows were committed and 249 collection holds cleared, for £3,033.42/month. Membership histories stayed unpaid/unactivated; Alpha payments, reservations and new instalment invoices remained zero. Beta's ten holds and the pilot's **pre-existing** release were unchanged. Read-only replay produced zero additional writes.
- Gate remains **2026-09-30T23:00:00Z = 1 October 00:00 BST**. Under the existing observed cron schedule, the first eligible scheduled run is **1 October 00:15 UTC / 01:15 BST**; this is not a guaranteed bank-debit date or a new live deployment observation.
- Durable per-member journal evidence records actor/user approval, the exact two waivers and risks, unchanged original evidence times, source/implementation hashes, fresh observations and the processing gate. `fullAlphaReadinessComplete` remains **false**. Economic review SHA: `caaa4192f60b1a6800dec599dce6623596d9f24d432da567927f28c94770b5da`; committed journal SHA: `df75d6864894f32d26ee0ec6ab78611d0ae2051d5e08939ffe4b8bec90ec34fd`.
- Private audit directory: `exports/private-bnms-alpha-operator-exception-20260923/` (0700; reports 0600). Use `apply.json`, `apply-postverify.json`, `apply-replay.json`, `apply-postreplay.json`, and **`apply-final-summary-v2.json`**. The v2 summary corrects a scope label in the first summary: five unchanged **tenant-wide** payments are not Alpha payments; exact Alpha counts are zero.
- Four same-person identity enrichments passed financial ownership checks. Their `role=owner` memberships remain a **separate security follow-up warning**; this release did not alter roles/authentication and does not authorize treating that authority as safe or fixing it without separate scope.