---
name: Tenant feed cron fairness
description: How to schedule a bounded multi-tenant external feed without permanently skipping tenants after a capped first query page.
---

For a time-bounded hourly tenant feed sync, select enabled tenants in a stable order after a persisted provider-specific cursor, persist the last actually processed tenant, and wrap only after a completed pass.

**Why:** a fixed `limit()` query processed from the beginning on every invocation leaves all tenants after the first page permanently stale. A runtime budget also has the same effect when a slow provider call stops a sequential loop.

**How to apply:** give each provider an independent cursor, query strictly after it in deterministic tenant-id order, advance it only after each attempted tenant (including a safely recorded failure), and reset it only after the available tail is complete. Bound provider calls with a timeout so cursor progress fits the serverless budget.