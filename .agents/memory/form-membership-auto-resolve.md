---
name: Form membership auto-resolve mode
description: How the form payment "membership structure" action resolves a structure automatically from a mapped answer.
---

A membership_structure form action with `resolve_mode: 'auto'` (config_id empty) is valid; the concrete structure is resolved at quote/charge time by matching the mapped answer against each ACTIVE member-scoped config's `structure_match_value` (case-insensitive, trimmed; unscoped member configs are a fallback). Shared pure resolver: `autoResolveMembershipConfig` in `api/_lib/formMembershipAction.js`.

**Why:** pinning one structure per rule meant unmatched member classes silently quoted £0; auto mode makes new tiers work without form edits and returns a descriptive error ("No membership structure matches 'X'") instead of a £0/price-source fallback.

**How to apply:**
- Server: `resolvePayableCharge` in `api/public/form-payment.js` resolves the concrete config BEFORE quoting; the stored quote carries the concrete config_id, so finalisation/charge-integrity need no auto awareness.
- Builder: auto mode requires mapping the structure-scoping field; `/api/membership/tier-required-fields?auto=1&scope=member` returns the union of required fields + resolvable configs preview.
- Client quote cache key must distinguish auto (`configId || 'auto'`) in `formPaymentQuote.js`.
- Classes with no structure should HIDE the payment field via a visibility rule (hidden payment short-circuits to no-payment before membership resolution).
- jsonb reorders object keys — idempotent form-fix scripts must compare rule structures semantically, never by JSON.stringify.
