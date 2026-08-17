---
name: GoCardless Drop-in modal
description: How DD signup surfaces open the GC Drop-in modal instead of redirecting, and the fallback contract.
---

All Direct Debit start endpoints return `{ authorisationUrl, flowId, environment }` — the same Billing Request Flow serves both the Drop-in modal and the hosted-redirect fallback. Client surfaces use ONE shared wrapper (`client/src/components/gocardless/GoCardlessDropinFlow.jsx`, built on `@gocardless/react-dropin`): it auto-opens when ready, and its `onLoadFailure` (script error OR 15s never-ready timeout) must redirect to `authorisationUrl`.

**Why:** users stay on-page (less drop-off); webhooks remain the only activation source — Drop-in `onSuccess` only shows the "mandate being confirmed" pending UX, never activates anything client-side.

**How to apply:** a new DD surface must (1) return flowId+environment from its start endpoint (resumed/raced branches too, from the stored agreement row), (2) render the shared wrapper keyed on flowId, (3) keep the return-URL pages working — redirectUri/exitUri stay on every flow for the fallback. Never guess environment client-side; it comes from the tenant's credentials. Migration page + self-service remandate card still redirect (server already returns flowId).
