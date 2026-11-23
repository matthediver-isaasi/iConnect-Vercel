---
name: Subscriber count authority
description: Category subscription counts versus campaign recipients and readiness evidence.
---
Do not “correct” category subscriber totals by imposing campaign recipient eligibility.
Preserve explicit consent counting independently of role assignments unless separately approved.

**Why:** The approved reliability work addressed incomplete browser inputs, not consent or
eligibility. Read-only GFI aggregates showed that an external-only value of one could coexist
with thousands of member subscriptions; local fixtures alone cannot prove live totals.

**How to apply:** Distinguish successful zero from missing/failed inputs, and label database
snapshots separately from browser reproduction. A lack of a new count request is expected
when cached member/preferences inputs are used to compute totals.
