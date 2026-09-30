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

Treat payment polling and page/iframe replacement as separate causes of apparent reloads.

**Why:** A status reset before every poll can look like a reload even when the document never remounts. Conversely, changing presentation parameters in an iframe URL resets the document and changes the scoped receipt key.

**How to apply:** Record document mounts and schema requests alongside visible status transitions. Preserve the last verified result during background checks, initialize receipts before paint, and settle URL-defining presentation context before mounting a payment-capable iframe. Receipt metadata controls display only; server confirmation remains the authority for side effects.

Chrome-readiness gates must not replace the parent component type around live form content.

**Why:** Switching a hidden wrapper to the public layout remounts descendants even without a changing React key. Request-local guards cannot preserve an iframe document or entered answers across that replacement.

**How to apply:** Keep the layout subtree mounted and change visibility while chrome resolves; verify document mounts and preserved input, not just network request counts.

For a server-verified one-off Stripe payment, applicant acknowledgement must not wait for background membership, invoice, or mapping completion.

**Why:** The user explicitly wants applicants to receive confirmation and leave immediately after payment; member access comes later through emailed login instructions. Internal retry or review states should not make a successfully paid applicant wait or pay again.

**How to apply:** Keep the applicant receipt distinct from backend completion and access. Acknowledge only verified payment, preserve safe return navigation and refresh behaviour, and leave setup/retry status authoritative on the server. Never claim immediate membership access.

Apply the same separation to monthly setup, but do not equate setup with collection or bank activation.

**Why:** GoCardless can confirm completed consent while the mandate is still pending submission or submitted; waiting for an active mandate would delay acknowledgement beyond the normal checkout experience. Stripe monthly can also complete setup without a first collection.

**How to apply:** Verify provider-owned setup evidence and matching identities, preserve actual collection evidence separately, and keep login instructions deferred. If browser confirmation stops running internal finalizers, ensure the existing form recovery sweep discovers the acknowledged setup; slower agreement-level recovery alone is not sufficient.

Embedded outcome navigation must follow a committed receipt and actual provider-overlay removal, not just an accepted callback or iframe resize.

**Why:** Inline completion has no hosted-return relay, and a tall form can shrink underneath a still-mounted GoCardless overlay. Scrolling before that overlay releases its height can leave the receipt outside the containing viewport.

**How to apply:** Keep inline completion distinct from relay-authorized hosted returns, report the final height before the one-shot readiness signal, and let Canvas settle before a visibility-aware parent scroll. Capture return navigation context before URL cleanup; later server-confirmed terminal transitions must not depend on payment query parameters still being present.