---
name: Mail delivery and evidence
description: Focused pointers for Mailgun readiness, correspondence, delivery evidence and recipient-history preservation.
---

- [HTTPS tracking](mailgun-https-tracking.md) — domain activation is not proof of tracking-host TLS readiness.
- [Sending-domain authorization](mailgun-sending-domain-auth.md) — a valid API key may reject an unregistered sending domain; keep visible From separate.
- [Direct member correspondence](member-outlook-recipient-boundary.md) — Mailgun CRM transport, intentional CC, contact eligibility, and acceptance versus history.
- [Campaign throughput](campaign-throughput-policy.md) — 5,000 in 15–20 minutes target; preview-first rollout and separate no-delivery benchmarks.
- [Email bounce authority](email-bounce-authority.md) — address-scoped suppression, chronological outcomes and provider-checked resolution.
- [Campaign click authority](campaign-click-authority.md) — iConnect requests own counts; provider evidence and historical totals do not prove human clicks.
- [Recipient history evidence](recipient-history-evidence-boundaries.md) — sender freezes do not freeze event writers; checksums and trigger assignments cannot reconstruct before-images.
- [Campaign removal policy](campaign-removal-policy.md) — removal is not permission to cancel delivery or reconcile uncertain provider work automatically.
- [Campaign outcome evidence](campaign-outcome-evidence.md) — skipped is not recalled; campaign age is not claim age, and uncertain processing is never a safe resend.
- [External campaign contacts](external-campaign-contacts.md) — non-members may lack subscriber rows; resolve them before shared suppression.
- [Group campaign claims](group-campaign-claims.md) — bind validated delivery snapshots and scheduled-worker selections to the atomic claim.
- [Campaign preparation progress](campaign-preparation-progress.md) — bounded resolver continuations must guarantee new progress, not just durable replay.