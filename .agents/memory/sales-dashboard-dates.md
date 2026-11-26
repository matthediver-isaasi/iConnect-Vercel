---
name: Sales dashboard dates
description: User-required day-first dates and expected-close filter scope.
---
Display Sales dashboard dates as DD/MM/YYYY, independent of the browser locale.

**Why:** The user explicitly rejected the dashboard's US date formatting.

**How to apply:** Keep day-first input and output consistent, and avoid shifting date-only expected closes across timezones. Expected-close controls belong to that card; they must not silently change the dashboard's financial totals.

Use explicitly labelled UTC for opportunity task completion times, not an
unlabelled browser-local time.

**Why:** The task-progress requirement calls for a consistent timezone across
tenants without tenant-specific behaviour. UTC was chosen to avoid ambiguous
cross-browser readings; this does not change the date-only expected-close rule.

**How to apply:** Preserve the timezone label when displaying completion
evidence, and keep task-progress scope independent of expected-close controls.
