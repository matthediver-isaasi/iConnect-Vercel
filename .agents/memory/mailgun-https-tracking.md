---
name: Mailgun HTTPS tracking reconciliation
description: How to decide whether a Mailgun domain is genuinely ready to emit secure tracking links.
---

Treat the final Mailgun domain GET as authoritative after create, update, or verify. A domain is fully ready only when `web_scheme` is HTTPS and the final domain state is active.

**Why:** Mailgun update and verify responses can lag the immediately following domain state, while transient intermediate GET failures can occur after the HTTPS setting was successfully applied. Persisting an earlier response creates contradictory readiness.

**How to apply:** Re-fetch after reconciliation, derive both the stored domain status and tracking TLS status from that same response, and preserve an actionable DNS/certificate error only when the final response still does not confirm HTTPS.