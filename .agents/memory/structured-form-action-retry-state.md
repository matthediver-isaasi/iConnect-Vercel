---
name: Structured form action retry state
description: Durable completion and retry semantics for persisted form action chains across public and paid processing.
---

Treat a structured action batch as incomplete when any invocation failed or is still owned by another worker. “Already running” is not a successful skip, and only terminal completed/already-completed outcomes may clear durable retry state. A downstream consumer of a fan-out collection must wait for every item before claiming its own ledger row. If any action consumes a primary pipeline output, defer the whole batch until every required primary output exists. The fingerprint-checked ledger is completion authority; notes are presentation history only.

**Why:** A concurrent worker can observe an active claim immediately before its owner fails. If the observer reports success, public idempotency or paid reconciliation can erase the only retry signal and strand a partially applied action chain. A consumer that finalizes against a partial collection can permanently miss the records completed on retry. Running upstream creates before the primary pipeline succeeds can leave orphan records when validation later rejects the submission. Trusting a completed note before checking the ledger lets changed inputs bypass fingerprint drift protection and feed stale outputs to descendants.

**How to apply:** Public duplicate responses must retain the incomplete result until a later processing run supersedes every failed/running invocation. Paid submissions must persist a pending marker and reconciliation must clear it only after the shared signed processor reports a fully terminal batch. Block collection consumers before their ledger claim unless every expected item has a canonical completed output. Require a matching configured primary pipeline for every primary-output endpoint; before those outputs exist, record retryable row outcomes without claiming or mutating. On retries, always enter the ledger claim path so the current fingerprint is checked.

Preflight validation must mirror which mappings execution actually applies: an existing selection in a record-reference resolver does not apply companion mappings; only its Not listed create/upsert branch does.

**Why:** Validating ignored companion mappings can reject a valid existing-record selection for a relationship conflict even though no mutation would occur.

**How to apply:** Exclude resolved existing items from companion-write preflight, including each existing item in multi-reference actions, while retaining validation for Not listed items.

Only a wholly side-effect-free primary-output wait may yield to primary pipelines; genuine failures and mixed outcomes must still stop processing. Completion shortcuts must not bypass unresolved structured work.

**Why:** Treating every incomplete batch as fatal creates a circular dependency before member creation, but allowing every failure through can duplicate partial effects. A successful address ledger alone cannot certify the rest of the submission, and a failed durable completion write must not authorize paid membership or Due Diligence readiness.

**How to apply:** Cover fresh creation and partial-checkpoint retries, including absent pending flags, completion-write failures and lease cleanup. Exercise both full-card payment and monthly setup: monthly setup must retain its unpaid/pending-activation meaning.

Distinguish an unresolved primary output from a primary pipeline that deliberately completed without creating an optional entity. Implicit post-primary work may proceed after settled absence; explicit endpoints needing that absent entity must fail, not wait forever.

**Why:** A populated Group can accompany an intentionally blank Organisation. Requiring a nonexistent Organisation ID blocks the Group and Member indefinitely. Conversely, falsely declaring absence can permanently hide invalid Organisation data on retry.

**How to apply:** Determine optional absence from the effective union of primary and top-level mappings, respecting destination precedence. Supplied non-name data or a Not listed selection without a name is invalid, not blank. Keep completion evidence server-owned.