---
name: Automatic-group source invalidation
description: Concurrency and batching rules for queuing automatic group membership after member source changes.
---

Source-data changes must increment the automatic-membership generation while
queuing reconciliation and clearing its cursor/error. Merely changing status to
queued does not fence a worker that already loaded the previous generation.

Custom preference tables need their own statement-level transition triggers.
Relying on row-level parent `updated_at` watermark triggers turns one bulk
custom-field import into one group invalidation per preference row.

**Why:** A running worker can otherwise commit membership calculated from stale
member data, while bulk preference imports can repeatedly invalidate workers and
prevent convergence.

**How to apply:** Queue at the source-table boundary, aggregate affected tenants
and rule fields per SQL statement, and keep insert/delete match-all behavior so
rules involving empty or absent values still converge.