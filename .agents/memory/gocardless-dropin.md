---
name: GoCardless Drop-in modal
description: How DD signup surfaces open the GC Drop-in modal instead of redirecting, and the fallback contract.
---

All Direct Debit start endpoints return `{ authorisationUrl, flowId, environment }` — the same Billing Request Flow serves both the Drop-in modal and the hosted-redirect fallback. Client surfaces use ONE shared wrapper (`client/src/components/gocardless/GoCardlessDropinFlow.jsx`): it auto-opens when ready, and its `onLoadFailure` (script error OR never-ready timeout) must redirect to `authorisationUrl`.

**Why:** users stay on-page (less drop-off); webhooks remain the only activation source — Drop-in `onSuccess` only shows the "mandate being confirmed" pending UX, never activates anything client-side.

**How to apply:** a new DD surface must (1) return flowId+environment from its start endpoint (resumed/raced branches too, from the stored agreement row), (2) render the shared wrapper keyed on flowId, (3) keep the return-URL pages working — redirectUri/exitUri stay on every flow for the fallback. Never guess environment client-side; it comes from the tenant's credentials. Migration page + self-service remandate card still redirect (server already returns flowId).

Treat provider success and provider teardown as different events; embedded sizing must follow actual overlay removal, not a successful application response.

**Why:** The vendor initializer appends a fixed, viewport-height iframe outside the form's natural wrapper. Its rectangle cannot reveal a required content height. Success leaves a receipt behind; return/exit removes it. The installed React SDK hook also lacks unmount cleanup and can create an unreachable handler during StrictMode replay before its state commits.

**How to apply:** Keep the official provider widget, but own handler creation and exit in the same lifecycle. Suppress cleanup-induced exit callbacks so successful setup never becomes an abandonment error. Use an independent responsive payment-height reservation in embedded documents; never inspect the cross-origin provider content or feed the assigned iframe height back into measurement. Verify lifecycle changes with mounted StrictMode tests, not helper-state tests alone.
