---
name: Payment return navigation
description: Preserve provider browsing context and embedded-form isolation without treating navigation as payment proof.
---

Provider departure and return must use the same browsing context. When a same-origin form iframe opens checkout in the containing window, return to that containing page and relay only to the originating form instance; never return the top-level window to the bare iframe URL.

**Why:** Returning a top-level Stripe checkout to an embed URL removed the tenant's header/navigation and stranded applicants on a completion message. Two copies of the same form also require instance isolation, not merely a matching form slug.

**How to apply:** Bind relay context to the page, form instance, submission and expiry; validate cancellation IDs as strictly as success IDs. Cross-origin hosts must not be navigated automatically. Keep terminal confirmation resumable without reopening payment controls, and never use URL parameters as proof of payment.

Validate URL path and query separately. Encoded separators in a pathname can be dangerous, but an encoded slash in a query value is normal data.

**Why:** Blanket encoded-slash rejection silently discarded otherwise valid parent return context while the server still accepted the URL, preventing the return relay.

**How to apply:** Enforce same-origin URL construction on the server and serialize the client return context consistently, including normal query values.