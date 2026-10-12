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

Improve bounded individual-message throughput before replacing delivery with
native provider batches unless batch recipient correlation and ambiguous-outcome
reconciliation have both been validated.

**Why:** Individual message ownership and provider IDs support the existing
duplicate protection and event attribution. A bulk request changes both;
reducing request count alone is not proof of a safe transport migration.

**How to apply:** Preserve fresh per-recipient authorization and suppression
checks as concurrency increases. Benchmark submission speed separately from
preparation by resuming the paused test campaign without resetting its rows.

Native bulk sending must use a fresh campaign with a creation-time transport
pin; never repurpose a running individual-send campaign for bulk benchmarking.
The user has explicitly deferred audience-resolution optimisation until the
bulk submission speed has been measured.

**Why:** Mixing transports mid-send obscures the comparison and complicates
recovery of uncertain provider acceptance. A no-delivery speed test cannot
validate the final received message's rendering or personalised headers.

**How to apply:** Keep rollout disabled until the additive migration and worker
code are deployed. Verify actual controlled-recipient rendering before live
bulk rollout; retain uncertain rows for reconciliation, not blind retry.

Bulk-worker tests must model realistic database latency across both preparation
and final eligibility checks, and prove forward progress within the *combined*
invocation budget.

**Why:** A bounded batch can repeatedly return every recipient to pending when
final revalidation consumes the provider's reserved time. Fast fixture queries
can pass while the live worker makes no submissions.

**How to apply:** Budget the final reads as well as provider submission. Prefer
bounded set-based eligibility reads and smaller/adaptive chunks without dropping
consent checks. Test that repeated invocations make progress, not merely that a
deadline stops sending safely.

The user accepts a final lightweight eligibility check but requires it not to
adversely impact send time.

**Why:** The user approved retaining a lightweight final check rather than
relying solely on the campaign's initial audience snapshot.

**How to apply:** Measure its overhead separately from preparation and provider
submission; avoid reinstating recipient-by-recipient database checks for bulk sends.
