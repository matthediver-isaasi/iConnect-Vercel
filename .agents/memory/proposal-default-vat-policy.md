---
name: Proposal default VAT policy
description: Sales default VAT applies to newly added free-text proposal lines, without rewriting historical tax.
---

Use the sales setting “Default product VAT code” for new free-text proposal
lines as well as new products. Carry the accounting provider's code identity,
not just a matching percentage.

**Why:** The owner expects that sales default to govern manually authored
proposal items too, rather than requiring the same VAT selection on every line.

**How to apply:** Initialise untouched new free-text lines, including when tax
options load late. Preserve explicit user choices and saved or legacy tax
snapshots. Never silently substitute another code when the default is unavailable.
