---
name: Dashboard widget series split & period-carrying derived dims
description: How grouped widgets get a second (stacked) dimension, and how derived dims that need a date range carry it.
---

The widget engine's group payload always had `categories: ['value']` and single-series renderers. Two-dimensional widgets (e.g. logins by organisation type) are done via an optional `config.seriesBy` — NOT a second groupBy:

- `seriesBy` is restricted server-side to the member source's derived `active_in_period` dimension; requires a groupBy, excludes timeBucket.
- Rows become `{ key, value: <total>, Active, Inactive }` with `categories: ['Active','Inactive']`. Keeping the `value` total means list/pie/CSV/drilldown consumers degrade gracefully; only the bar renderers (WidgetCard + builder preview) branch on `categories !== ['value']` to render stacked `<Bar stackId>` per category.

**Derived dims needing a parameter date range** (active_in_period): the range rides as `from`/`to` strings on whichever ref uses the dim (groupBy / seriesBy / each filter), so different refs can use different ranges. Date-only strings expand UTC start-of-day / end-of-day. zod schemas strip unknown keys — new ref params MUST be added to filterSchema/groupBySchema or they silently vanish before the engine sees them.

**Member org_type dimension**: hydrated per row via organization_id → org-scoped `org_type` preference field (same as DD source); no org / no value = explicit 'Unknown' bucket (not 'Unspecified'). Options published per tenant in resolveSystemFields with 'Unknown' appended so eq filters can target it.

**Why:** first widget needing "both sides of a split per group"; engine only supports one grouping dimension otherwise.
**How to apply:** to add another series-capable dimension, widen the engine's seriesBy guard + builder toggle rather than inventing a parallel mechanism.
