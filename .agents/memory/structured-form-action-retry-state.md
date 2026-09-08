---
name: Structured form action retry state
description: Durable completion and retry semantics for persisted form action chains across public and paid processing.
---

Treat a structured action batch as incomplete when any invocation failed or is still owned by another worker. “Already running” is not a successful skip, and only terminal completed/already-completed outcomes may clear durable retry state. A downstream consumer of a fan-out collection must wait for every item before claiming its own ledger row.

**Why:** A concurrent worker can observe an active claim immediately before its owner fails. If the observer reports success, public idempotency or paid reconciliation can erase the only retry signal and strand a partially applied action chain. A consumer that finalizes against a partial collection can permanently miss the records completed on retry.

**How to apply:** Public duplicate responses must retain the incomplete result until a later processing run supersedes every failed/running invocation. Paid submissions must persist a pending marker and reconciliation must clear it only after the shared signed processor reports a fully terminal batch. Block collection consumers before their ledger claim unless every expected item has a canonical completed output.