---
name: Portal pending Direct Debit evidence
description: Keep setup completion, joined pricing, and collection authority independent in member-facing cards.
---

Completed setup evidence is independent of whether the joined price is readable. Missing or contradictory pricing must not ask an already-authorised member to repeat setup.

**Why:** A bank-pending signup can have no payment plan yet. A historical quote is neither a scheduled charge nor proof of authorisation; each fact needs its own evidence.

**How to apply:** Use scoped processed fulfilment and pending bank evidence for reassurance, immutable joined pricing only for the separate expected amount, and collection facts after activation for actual payment amounts/dates.

For this evidenced pending state, suppress the generic saved manage link as well as the explicit renewal link, without rewriting author labels.

**Why:** Existing portal designs can label the generic manage link “Renew subscription”; text matching would miss custom labels or silently change their meaning.

**How to apply:** Gate by the server-established pending state, not by authored link text. Preserve links and their labels in other lifecycle states.

Import server handlers before installing JSDOM browser globals in API-to-card integration tests.

**Why:** Importing this backend dependency graph after creating `window` left the Node test runner alive even after every assertion passed; server-first imports exited cleanly.

**How to apply:** Use a static server-handler import with an injected read-only database fixture, then install browser globals before dynamically importing the UI.