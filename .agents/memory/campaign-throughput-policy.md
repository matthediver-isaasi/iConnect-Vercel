---
name: Campaign throughput rollout
description: User-approved performance target, preview-first rollout and safe test-mode benchmarking.
---

The user considers 5,000 campaign messages submitted in 15–20 minutes acceptable.
Treat this as an end-to-end target including audience preparation, not a promise
of inbox delivery time or an already-demonstrated result.

**Why:** Tenants are complaining about several-hour campaign sends; the user
approved a staged investigation, low-risk optimisation and compatible Mailgun
batch-send rollout.

**How to apply:** Stage code in preview before production. Do not reset or change
an active production campaign to benchmark. Use a separate test-mode campaign,
verify the provider no-delivery flag, and distinguish campaign test mode from
the deliberately delivered Send test email action. Preview is not database
isolation; provider test mode is not exemption from consent or account limits.
