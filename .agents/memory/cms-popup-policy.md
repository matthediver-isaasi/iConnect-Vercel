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

Only explicitly reviewed read-only background loaders may be exempted from popup busy checks; unknown busy elements remain blocking.

**Why:** Diagnostic traces showed several seconds waiting after page eligibility was ready, but did not identify the specific busy element. Removing every busy check would also bypass embedded forms and transactional flows.

**How to apply:** Keep accessibility busy indicators intact, label reviewed content loaders explicitly, preserve critical-flow precedence, and reuse session validation only within one request—not between eligibility and selected-content authorization.

Portal targeting is explicit and main-site only; existing “all CMS pages” never opts a popup into built-in portal routes.

**Why:** Portal delivery was approved as an extension of existing popup records, not permission to broaden existing assignments or reset member preferences.

**How to apply:** Curate new non-transactional targets deliberately, require current member page access even on hybrid/public chrome, and keep preference identity independent of target surface.
