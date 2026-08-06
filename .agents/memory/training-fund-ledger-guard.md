---
name: Training fund balance is ledger-guarded
description: Org training fund balances may only change via paths that write the ledger row atomically; generic write paths strip/skip them.
---

Rule: the organization training fund balance columns may only change through a path that writes a `training_fund_transaction` ledger row in the SAME database transaction (a Postgres function doing an in-place `col = col + delta` under the row lock plus the ledger insert). Generic write surfaces — the entity API, BOTH workflow executors (there are two: a serverless one and a server-engine one), and form field mappings — strip or skip these fields; a shared protected-field helper with a source-level regression test keeps them in lockstep.

**Why:** client-side read-modify-write (e.g. an org-detail save carrying a stale balance snapshot) silently corrupted balances vs the ledger; the drift indicator on /TrainingFundManagement flags any divergence.

**How to apply:** never re-expose these columns as writable in admin field lists; any new balance-changing feature needs a new atomic RPC, never a balance update plus a separate ledger insert. Beware: booking payment/cancellation paths still do non-atomic two-step server-side writes (known follow-up).
