---
name: Original new-member incentive evidence
description: Why Year 2 rollover must preserve original entitlement rather than reconstruct it from renewal pricing.
---

An unused new-member incentive is an original entitlement less historical usage, not a fresh discount priced against the renewal schedule. Advancing the evaluation date or recording Year 1 must not revoke it.

**Why:** Current-year-relative newness incorrectly removed unused credit at the renewal boundary. Later schedule, price, or custom-discount changes cannot establish the value originally promised.

**How to apply:** Prefer the joining commitment snapshot and saved usage. Without a snapshot, require evidence that the history-linked configuration existed unchanged when the original term was recorded. Ambiguous evidence must stop billing for review rather than silently assume zero credit. Duration incentives retain their original daily valuation; do not transfer nominal credit across currencies. No historical repair or migration is implied by changing the calculation.

Organisation tab estimates may project an unrecorded current Year 1 into Year 2, but must remain distinct from historical entitlement evidence.

**Why:** Requiring historical configuration timestamps for an explicitly prospective estimate hides valid new-organisation projections, especially banded pricing and year-scoped overrides. Conversely, unpaid recorded commitments already provide authoritative evidence and must never be replaced by speculative projections.

**How to apply:** Derive prospective usage internally from a successful current Year 1 calculation, retain year-scoped override semantics, and mark the successor display-only. Financial callers must continue through historical evidence checks, not accept a tab estimate as authority.

An absent joining date may be an explicit assumption in both unrecorded tab projections, but never proof of a historical joining date.

**Why:** Year 1 already assumes today when no date is set; requiring a saved date only for its Year 2 estimate creates inconsistent previews. A failed read must not be mistaken for absence.

**How to apply:** Verify absence with strict reads, disclose the assumed date in the estimate, require empty history, and leave financial and recorded-commitment evidence rules unchanged.