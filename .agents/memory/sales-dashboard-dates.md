---
name: Sales dashboard dates
description: User-required day-first dates and expected-close filter scope.
---
Display Sales dashboard dates as DD/MM/YYYY, independent of the browser locale.

**Why:** The user explicitly rejected the dashboard's US date formatting.

**How to apply:** Keep day-first input and output consistent, and avoid shifting date-only expected closes across timezones. Expected-close controls belong to that card; they must not silently change the dashboard's financial totals.
