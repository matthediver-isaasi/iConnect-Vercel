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

An offline adapter must reproduce schema errors, selected-column projection and
SQL NULL semantics, not just return matching full objects.

**Why:** A live reminder helper ignored an error from a nonexistent contact
column. Inventing that field or returning a successful empty lookup would hide
the actual routing failure. Returning extra snapshot fields can also let a
calculation use data that its real SELECT never loads.

**How to apply:** Verify schema before capture; reproduce observed provider
errors at the corresponding query, project the requested columns, and exclude
NULL values from ordinary SQL inequality matches. Keep these adapter checks
separate from the application's own financial checks.

Pure renewal assessments also need the successor schedule effective at the
renewal boundary, not simply today's schedule.

**Why:** Passing no successor or the current version can report “structure
unavailable” for sound historical terms whose next boundary used an earlier version.

**How to apply:** Reproduce the production schedule-resolution inputs before
treating that assessment as a defect or changing membership records.

Derive deletion markers before redacting personal data from membership audits.
Deleted records must be excluded from renewal-repair cohorts.

**Why:** Anonymised members can retain an active status; removing emails without
retaining the deletion signal falsely included deleted accounts in renewal
blockers and reconstruction recommendations. The owner explicitly excludes
deleted members from this work.

**How to apply:** Capture a non-identifying deletion boolean using the application's
deletion convention, then omit contact data. Check exclusions before selecting
repair candidates and counting failures, not just when rendering the report.
