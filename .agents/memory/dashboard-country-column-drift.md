---
name: Dashboard sources registry vs real schema (organization.country)
description: The dashboard source registry can declare system columns that don't exist in the DEST schema
---
The dashboard sources registry (`api/dashboard/_lib/sources.js`) declares `organization.country` as a system field, but the column does NOT exist in the DEST Supabase schema — selecting it fails with 42703 undefined column.

**Why:** the widget engine only selects columns a widget actually references, so the registry entry has never been exercised against the real table; new code that trusts the registry and selects `country` breaks at runtime.

**How to apply:** any new surface reading dashboard "system fields" directly from the base tables must either verify the column exists or drop-and-retry on error code 42703 (pattern used by `api/admin/settings/country-data-quality.js`). Country data in practice lives in `country`/`countries`-typed preference fields.
