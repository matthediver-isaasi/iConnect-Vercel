---
name: Mailgun HTTPS tracking reconciliation
description: How to decide whether a Mailgun domain is genuinely ready to emit secure tracking links.
---

Treat the final Mailgun domain GET as authoritative after create, update, or verify, but do not treat Mailgun activation or `web_scheme: https` as proof that tracking TLS is ready. Resolve the exact tracking hostname from Mailgun's unambiguous, valid tracking CNAME and perform a trusted TLS handshake with SNI for that hostname.

**Why:** Mailgun update and verify responses can lag, and an active HTTPS-configured domain can still serve Mailgun's origin certificate rather than a certificate valid for the tenant tracking hostname. Browsers then block tracked and unsubscribe links.

**How to apply:** Keep sending-domain activation, tracking DNS validity, HTTPS scheme, and live certificate readiness as separate states. Only the last state may declare tracking TLS ready; certificate-pending verification is an actionable nonfatal result.