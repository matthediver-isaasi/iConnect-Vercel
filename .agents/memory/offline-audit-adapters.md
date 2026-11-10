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

Derive deletion markers before redacting personal data from membership audits.
Deleted records must be excluded from renewal-repair cohorts.

**Why:** Anonymised members can retain an active status; removing emails without
retaining the deletion signal falsely included deleted accounts in renewal
blockers and reconstruction recommendations. The owner explicitly excludes
deleted members from this work.

**How to apply:** Capture a non-identifying deletion boolean using the application's
deletion convention, then omit contact data. Check exclusions before selecting
repair candidates and counting failures, not just when rendering the report.
