---
name: Email preference consent serialization
description: Concurrency and identity rules for recipient-managed global and category email preference writes.
---

Global and category email preference writes for one tenant/email identity must serialize on the same transaction lock. Recheck the global opt-out inside the category transaction, and commit subscription rows, the member global flag, and unsubscribe-ledger rows atomically. Canonicalize ledger email values at the database boundary before enforcing uniqueness, and deploy that uniqueness contract in the same migration as RPCs whose `ON CONFLICT` clauses depend on it.

**Why:** An API-level check has a race: a category re-subscribe can pass just before a concurrent global opt-out, then erase the persisted category opt-out. Removing the global opt-out later silently enables that category. Multi-write application flows can also leave contradictory consent state after a partial failure. Raw-email uniqueness also treats case/whitespace variants as different recipients unless canonicalization happens before the unique check.

**How to apply:** Use explicit desired state rather than toggle semantics. For campaign links that resolve to a member, use the member's current email as the consent identity; use the historical campaign recipient email only for external subscribers. Suppression reads must compare the same trimmed, lowercased identity.

One-time current-member consent resets must preserve historical-email suppression
records that do not match a current target identity, and preserve orphaned
preference rows rather than treating them as subscriptions to recreate.

**Why:** Production preflight has found null-member preferences and suppression
records still linked to members whose current email was changed or anonymized.
Resetting a current member is not authority to clear consent history for an old
address, which might later identify someone else.

**How to apply:** Count these as unchanged exclusions, not unresolved current
subscriptions. Still fail closed if an old ledger's address overlaps a current
target but its member reference disagrees with that identity.