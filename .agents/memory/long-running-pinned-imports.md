---
name: Long-running pinned imports
description: Operational rule for imports whose safe sequential writes can exceed an interactive command timeout.
---

Run large pinned imports so an external interactive-shell timeout cannot be mistaken for transaction-level rollback. If interrupted, first run the non-mutating planner to measure the partial state, then resume only when every operation is idempotent and finish with a zero-write replay.

**Why:** Compensation journals exist only in the running process. An external process kill can leave a valid partial prefix even when application-level compensation is correct.

**How to apply:** Prefer a background execution path for large sequential imports. After any interruption, never assume either full success or full rollback; re-plan, resume idempotently, and verify the complete cohort and preservation boundaries.

Read-only provider readiness scans can also exceed interactive command limits because intentional pacing is part of their safety contract.

**Why:** Hundreds of exact provider reads at the required cadence can outlast a five-minute shell without completing evidence. Restarting immediately adds provider load but does not produce a valid report.

**How to apply:** Use the tool's supported background execution and monitor its result; never shorten pacing or extend the oldest-evidence freshness budget to fit a shell timeout. A failed or interrupted scan is not complete readiness.

Retain safe HTTP 429 diagnostics before stopping a provider scan.

**Why:** A generic rate-limit error hides which provider imposed the wait and whether it supplied a retry time.

**How to apply:** Record pinned provider identity, UTC observation time, status, fixed endpoint template, validated Retry-After/reset headers and allowlisted request IDs. Exclude bodies, authorization, resource IDs and query strings. Honor Retry-After, explicitly distinguish missing headers, and reacquire complete fresh evidence after the wait; do not automatically retry an invalidated scan.

Distinguish implemented financial release guards from optional browser acceptance checks.

**Why:** Authenticated deployment/provider verification is not member-session verification; a historical UI-test limitation does not establish an additional financial release gate.

**How to apply:** Inspect the actual release contract and honor all its scope, deployment, provider, freshness and transaction guards. Report browser verification separately unless explicitly required; never invent a browser-session requirement or fabricate authentication evidence.

Persist provider acquisition separately from release freshness.

**Why:** Paid historical invoices can still be refunded or edited, contacts archived, and new payments added while a rate limit is in force. Finishing a cached historical scan does not prove today's financial state.

**How to apply:** Alpha's private GET checkpoint retains actual observation times and list-generation groups, scoped to destination, manifest, tenant/provider account, environment and invoice-date semantics. Resume successful pages/contact reads for discovery, enforce saved Retry-After before reads, then invalidate whole stale paginated lists for final revalidation; never combine an old first page with a fresh tail as release evidence. The 15-minute oldest-observation guard still applies. Long waits necessarily require mutable rechecks even though acquisition progress is saved; do not promise zero repeated API reads. Invoice filtering uses invoice Date >= 2026-01-01 without a future-date cap.

Provider identity claims alone do not authorize cached financial evidence.

**Why:** A tenant's stored credentials can rotate or be reassigned between scans; a fresh cached invoice list also cannot exclude an invoice created after dry-run.

**How to apply:** Authenticate the pinned Xero connection and GoCardless creditor outside the cache before any replay, bind cached generations to non-secret credential digests, and discard prior responses on credential rotation. Canonical Alpha apply forces a complete fresh provider pass and compares the reviewed economic hash; the 15-minute window does not authorize replaying dry-run results as final apply evidence. Enforce saved cooldown before deployment verification and again immediately before OAuth refresh after a wait.