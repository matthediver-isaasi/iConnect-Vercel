---
name: GoCardless arrears & DD console
description: Durable invariants for DD arrears handling and admin-console authz that future changes must preserve.
---

- **Grace days are a SNAPSHOT, and the grace window is non-rolling.** Grace comes from the agreement's stored metadata at consent, never live tier config; repeat failures inside grace keep the original expiry, only post-expiry failures escalate to overdue.
  **Why:** changing tenant config must never retroactively shorten/extend a member's already-running grace period, and re-failed retries must not push the deadline out forever.
  **How to apply:** any new failure path must reuse the existing failure handler, not recompute grace from config.
- **The never-double-charge guard must THROW (fail-closed).** It once returned `{ok,reason}` while every call site wrapped it in try/catch — a silent pass-through that would have allowed retrying an in-flight payment. A retry may only proceed when the LIVE GoCardless payment status is exactly `failed`.
  **How to apply:** new retry surfaces call the shared assert and surface the throw as a 409; never re-implement the check inline.
- **Collection retries and cancellation must share one plan-level claim.** Automatic and manual retries serialize together, while cancellation invalidates the claim; retry must recheck mandate, claim, plan state, grace, and current policy immediately before the provider mutation.
  **Why:** checking eligibility only before provider reads leaves a window where cancellation can complete and a retry can still collect.
  **How to apply:** every new collection-retry or cancellation path must participate in the shared claim protocol; automatic and manual attempt sequences remain separate.
- **Arrears policy must not be applied twice** when cron and webhook processing race; `keep_active` must not silently become access restriction. Do not assume historical bookkeeping-only limitations still apply: inspect current policy enforcement before diagnosing an access issue.
- **Use the membership schedule's existing fallback-role mechanism for post-grace restriction; do not add a separate privilege mechanism or hardcoded role.**
  **Why:** The owner explicitly selected role-based restriction with portal login retained so members can resolve payment, and required reuse of schedule settings.
  **How to apply:** Keep payment recovery accessible through the configured tenant role. The owner explicitly approved reusing the schedule's renewal fallback after unresolved-payment grace, including replacing Manual review for that case, without changing schedule settings. Preserve BNMS Full member junior with NMC's existing CPD Guest selection; do not hardcode it or change annual-renewal behaviour. This decision does not itself authorise bulk live role changes.
- **Post-payment-grace recovery must use the existing full renewal journey and start a new term on successful payment, not resume the old term.**
  **Why:** The owner explicitly chose a new membership term and the existing renewal journey rather than a separate Direct Debit recovery flow.
  **How to apply:** Preserve original history and outstanding debt; do not fake prior settlement, remove duplicate-checkout protection or reactivate the cancelled collection arrangement to expose the CTA.
- **Admin money-moving actions need server-side feature RBAC, not just `hasAdminAccess` + client gating.** Pattern: tenant-user dashboard sessions (no roleId) pass; member-role admins need the console feature key, and refunds additionally need the finance feature key.
- **Approved payment-method corrections can supersede an import relationship without erasing its audit ledger.**
  **Why:** A verified upfront correction detached a membership from its cancelled Direct Debit agreement; treating the retained adoption reference as a current relationship blocked the whole console.
  **How to apply:** Require explicit correction provenance and matching prior ownership plus cancelled billing before recognising a superseded relationship. Never attach old administrative recognition to the replacement paid term, reactivate collections, or ignore unrelated ownership mismatches.
