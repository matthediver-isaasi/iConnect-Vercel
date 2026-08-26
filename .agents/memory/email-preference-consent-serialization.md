---
name: Email preference consent serialization
description: Concurrency and identity rules for recipient-managed global and category email preference writes.
---

Global and category email preference writes for one tenant/email identity must serialize on the same transaction lock. Recheck the global opt-out inside the category transaction, and commit subscription rows, the member global flag, and unsubscribe-ledger rows atomically.

**Why:** An API-level check has a race: a category re-subscribe can pass just before a concurrent global opt-out, then erase the persisted category opt-out. Removing the global opt-out later silently enables that category. Multi-write application flows can also leave contradictory consent state after a partial failure.

**How to apply:** Use explicit desired state rather than toggle semantics. For campaign links that resolve to a member, use the member's current email as the consent identity; use the historical campaign recipient email only for external subscribers.