---
name: DD widget synthetic "moved to stage" date dimension
description: How a derived-from-history date field is wired into DD dashboard count widgets, and what to mirror if adding another synthetic DD dimension.
---

# DD widget synthetic date dimension ("Date moved to stage…")

A DD dashboard date dimension can be **derived per-row from `history_log`** rather
than being a stored column. The `moved_to_stage` field is computed at aggregation
time and then flows through the *existing* bucket/filter machinery.

**Why:** DD submissions don't store "when did this first enter stage X" — it only
exists in the status-transition history. Computing it once per row and stuffing it
into `row.moved_to_stage` lets `bucketTimestamp`/`matchFilter` treat it like any
ordinary date field (ISO string; null rows drop out).

**How to apply — to add another synthetic DD date/dimension, touch these 4 places:**
1. `api/dashboard/_lib/sources.js` — add the systemField to the `dd_submission`
   source. Stage-style fields carry `stageField:true` + `stageOptions`.
2. `api/dashboard/_lib/aggregation.js` `runDdWidgetConfig` — detect the field
   (as time-bucket field AND as a filter field), gate the `history_log` fetch on a
   `needsHistory` flag (don't always fetch history), resolve any required
   parameter (the chosen stage; prefer `timeBucket.stage`, else first filter's
   `stage`), and populate `row.<field>` before bucketing/filtering. Throw if the
   field is used without its required parameter.
3. `api/dashboard/_lib/validation.js` — allow the new optional param (`stage`) on
   `timeBucketSchema` AND `filterSchema`.
4. `client/src/components/dashboard/WidgetBuilderModal.jsx` — `buildFieldOptions`
   must carry the extra metadata (`stageField`/`stageOptions`); render the param
   picker for the time-bucket field and for filters on that field; add it to
   `validationErrors` (gates Save).

**Gotchas:**
- Stage matching reuses `canonicaliseDdStatus` so UUID status ids and labels both
  match — never string-compare raw status values.
- Each submission is counted once, in the bucket of its **first** entry into the
  stage (`findFirstTransitionAt`); never count re-entries.
- `WidgetCard.jsx` needs no change — it's an ordinary count over time buckets; the
  chosen stage is conveyed by the user's widget title, not a code-level subtitle.
