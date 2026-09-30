---
name: Country name resolution & LMIC surfaces
description: How stored country values resolve to ISO-2 and which dashboard paths depend on it
---
Stored country values are free text: canonical names, ISO-2 codes, World Bank publication style ("Congo, Dem. Rep.", "Lao PDR", "Egypt, Arab Rep."), and curly-apostrophe variants. `resolveCountryToIso2` (shared/countries.js) normalises apostrophes and falls back to a NAME_ALIASES map.

**Why:** real tenant data (GSF countries-of-operation field) contained WB-style names that silently failed both the LMIC row filter and bucket pruning — genuine LMIC orgs vanished with no error.

**How to apply:** any new surface that matches or buckets country values MUST go through `resolveCountryToIso2`, never raw string compare. LMIC semantics are two-layer: the ROW filter is any-element (org passes if any country is LMIC), but ELEMENT-level pruning is required separately on both the count_distinct measure path AND the group-by path — pruned rows create NO bucket (not "Unspecified"). If a variant still doesn't resolve, add it to NAME_ALIASES rather than special-casing a caller.

`not_lmic` is the inverse operator with ASYMMETRIC empty-list semantics: `lmic` + empty tenant list matches nothing, `not_lmic` + empty list matches every resolvable country; unresolvable values match NEITHER operator. Both operators require the same 4-surface wiring: row filter (matchFilter list+scalar), measure element pruning, group-by pruning (pruneLmicGroupKeys invert option), and region derivation (deriveRegionBucket lmicInvert). Any guard that requires `lmicCodes.length > 0` must be bypassed for the inverted mode.
