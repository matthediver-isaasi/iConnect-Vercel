---
name: Membership tier scheduling
description: How future-dated membership tier/pricing structures stay dormant until their start date
---

# Membership tier structure scheduling

`membership_tier_config` is scoped per `(tenant_id, structure_field_id, structure_match_value)`; each scope is an independent timeline.

**Invariant the whole system relies on:** a config is "in effect" on a date when
`(effective_from IS NULL OR effective_from <= date)` AND `(effective_to IS NULL OR effective_to >= date)`.
The canonical helper is `getAllActiveConfigs(tenantId, onDate)` in `api/_lib/membershipConfigResolver.js` (default onDate=today). `api/membership/tiers.js` has matching `isConfigInEffect` / `configLifecycleStatus` (active|scheduled|historical).

**Why not just effective_to IS NULL = active:** that treats a future-dated structure (effective_to null, effective_from > today) as live immediately. Scheduling requires the date-aware test above.

**How a switch-over is stored:** saving a new future-dated structure caps the currently-in-effect structure to `effective_to = newStart - 1 day` (UTC arithmetic) and inserts the new one open-ended (effective_to null). So at most one config per scope is in effect on any date, and downstream consumers that resolve "today" stay correct.

**Known gap (see follow-up tasks):** the reminders cron `processTenantReminders` in `api/_lib/membershipReminders.js` still filters on `effective_to IS NULL` instead of date-aware resolution, and the tiers.js UPDATE path doesn't re-cap when a scheduled structure's start date is edited in place.
