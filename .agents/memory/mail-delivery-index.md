---
name: Mail delivery policies
description: Focused pointers for Mailgun readiness and direct member correspondence.
---

- [HTTPS tracking](mailgun-https-tracking.md) — domain activation is not proof of tracking-host TLS readiness.
- [Sending-domain authorization](mailgun-sending-domain-auth.md) — a valid API key may reject an unregistered sending domain; keep visible From separate.
- [Direct member correspondence](member-outlook-recipient-boundary.md) — Mailgun CRM transport, intentional CC, contact eligibility, and acceptance versus history.
- [Campaign throughput](campaign-throughput-policy.md) — 5,000 in 15–20 minutes target; preview-first rollout and separate no-delivery benchmarks.