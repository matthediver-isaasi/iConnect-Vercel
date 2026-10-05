---
name: Deferred card Checkout timing
description: Stripe Checkout short-lead limits and evidence boundaries for early renewal
---

Early card renewal must not simply use a trial for every future start.

**Why:** Stripe Checkout requires trial_end at least 48 hours ahead; a near-term
successor can instead use billing_cycle_anchor with proration_behavior=none.
The anchor must fall within one recurring interval. A Checkout completed after
that anchor can bill the full anchored period. Provider schedule changes must
preserve the trial boundary or authorization can accidentally become collection.

**How to apply:** Preserve first-charge authority from the successor consent;
leave timing headroom for Checkout expiry and idempotent retries. Keep provider
trial semantics separate from membership access. Require test-clock evidence
before claiming real collection timing or instalment-count verification.
