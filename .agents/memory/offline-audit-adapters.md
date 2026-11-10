---
name: Offline audit query adapters
description: Avoid confusing incomplete offline query support with genuine payment projection failures.
---

Validate the adapter's supported query operations before interpreting a shared
helper's unavailable result as a persisted-data defect.

**Why:** Optional collection projections catch query errors and return unavailable.
An offline adapter lacking OR/date filters can therefore make valid collection
evidence appear unavailable for a whole cohort without throwing to the audit.

**How to apply:** Cover nested-field, OR/date and repeated-pagination semantics
with fixtures; cross-check representative unavailable outcomes against the actual
helper query path. Keep missing tables and unsupported operations explicit.
