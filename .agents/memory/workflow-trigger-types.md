---
name: Workflow trigger types & scheduled workflows
description: How workflow trigger_type works, why adding a new one needs no migration, and how scheduled evaluation differs from event-driven.
---

# Workflow trigger types

`workflow.trigger_type` is a free-text column (no DB allowlist, no server-side
enum validation in `api/`). Adding a new trigger value (e.g. `scheduled`)
needs **no migration** and no schema change — `trigger_config`/`conditions`
are JSONB and accept arbitrary shape. The builder's `TRIGGER_TYPES` list in
`client/src/pages/WorkflowManagement.jsx` is the only gatekeeper for what users
can pick.

**Why:** there is no `insertWorkflowSchema` enforcement on the create/update
path, so trigger semantics live entirely in the engine + UI.

# Scheduled vs event-driven evaluation

Event-driven workflows fire from record create/update via `triggerWorkflows` /
`triggerPreferenceWorkflows` and have before/after values. Scheduled workflows
have **no triggering record and no "before" value** — a cron sweep
(`api/cron/run-scheduled-workflows.js`, hourly) calls `runScheduledWorkflow`,
which iterates the workflow's tenant records, resolves each condition's current
value, and runs actions for matches.

- Condition operator comparison is centralized in `evaluateConditionOperator`
  (single source of truth shared by all three paths). Change-based operators
  (`changed_to`/`changed_from`) are meaningless for scheduled (before is undefined).
- Date operators (`date_*`) assume **UTC**; "today" is date-only, "past/future"
  use the full timestamp. Empty/invalid values never match and never throw.
- `once_per_record` vs `every_time` is honored via `checkOncePerRecord` exactly
  like the event path; a once-per-record scheduled workflow only logs (and thus
  only counts as "already ran") after conditions match AND actions execute.
- Schedule config lives in `trigger_config` as `{ frequency: 'daily'|'hourly',
  run_time: 'HH:MM' }` (UTC); `isScheduledWorkflowDue` decides per-tick.

**How to apply:** when adding workflow condition logic, edit
`evaluateConditionOperator` once — do not re-duplicate the switch. When adding a
new trigger type, wire the engine path + a `TRIGGER_TYPES` entry; no migration.
