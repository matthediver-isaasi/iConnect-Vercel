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

**UI lifecycle and editability are separate:** a capped structure remains lifecycle `active` until its future `effective_to`, but the tiers update API treats any non-null `effective_to` as immutable. Show its date-aware status as Active while also marking it read-only.

**Why:** collapsing these into one predicate either mislabels the current structure as historical or offers Edit/Save actions that the API will always reject.

**How to apply:** use the date-aware lifecycle helper for grouping/status labels and the server immutability rule (`effective_to == null`) for edit controls.

**Known gap (see follow-up tasks):** the reminders cron `processTenantReminders` in `api/_lib/membershipReminders.js` still filters on `effective_to IS NULL` instead of date-aware resolution, and the tiers.js UPDATE path doesn't re-cap when a scheduled structure's start date is edited in place.

## BNMS approved renewal-date coverage

BNMS authorised continuous, non-overlapping schedule coverage from 01/01/2026, using approved current settings for previously uncovered periods while preserving existing historical versions and prices. This does not authorise rewriting members' saved terms or changing renewal/grace windows.

**Why:** A member can be within grace yet unable to renew because no schedule covers the day after their saved expiry. Backdating every current version indiscriminately introduces overlaps and leaves renewal selection ambiguous.

**How to apply:** Preserve anniversary-based successor dates. Fill only uncovered periods, keeping existing version boundaries intact; do not interpret this approval as pricing authority for dates before January 2026.
