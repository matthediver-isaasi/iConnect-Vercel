---
name: CMS popup delivery policy
description: Popup independence, visitor opt-outs and affiliation interpretation
---
Popup content is a standalone Canvas document, not a hidden routable CMS page.
Permanent choices survive ordinary edits, pause and archive/restore; only an
explicit confirmed dismissal reset may invalidate them.

**Why:** The approved Phase 1 specification treats visitor preferences as an
independent authority, not a side effect of publishing a new design.

**How to apply:** Keep configuration revision and dismissal generation separate.
One popup may open per history-entry page view regardless of login/logout.
Do not reuse bulk campaign-recipient enumeration for public delivery.
All organisation conditions within one AND group must match the same real
affiliation; department ownership alone does not establish affiliation.

Stripe.js can mount an invisible telemetry iframe on ordinary non-payment pages.

**Why:** A public homepage contained this iframe even with no checkout open; treating every Stripe iframe as payment activity suppressed all CMS popups.

**How to apply:** Distinguish visible payment/authentication frames from hidden background frames. Keep explicit critical-flow markers authoritative and defer while a real consent dialog is open.

Early popup discovery may overlap page-content loading, but must never substitute for fresh selected-content authorization.

**Why:** Sequential page loading and eligibility requests caused a substantial delay. Caching permission or selected designs to hide that delay would weaken revocation and member-isolation protections.

**How to apply:** Keep early discovery component-owned, short-lived and bound to the resolved page and viewer. Require successful page loading and all display gates, and always authorize the selected popup afresh.
