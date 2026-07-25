---
name: Dashboard derived group-only dimensions
description: Pattern for adding a query-time-derived dimension (e.g. Region) to a dashboard widget source
---

A dashboard dimension with no stored column (e.g. organisation **Region**, classified at query time from `countries`-typed preference fields) must be wired as **group-only**:

- **Source registry:** mark the systemField with `derived: '<name>'` + `groupOnly: true` and publish its fixed `options` so pickers/legends know the buckets.
- **Aggregation engine:** exclude it from the SQL column selection (`systemColumns`), reject it up front as measure / additionalField / filter / timeBucket with a clear error (otherwise it reaches PostgREST as a nonexistent column), and compute per-row buckets after base rows + custom filters, keyed by row id.
- **Builder UI:** `buildFieldOptions` must carry `groupOnly` and the measure + filter pickers must exclude such options; the time-bucket picker already filters to `type === 'date'`.
- Multi-value derivations must read the FULL stored list — the generic `valueFor`/`extractPrimitive` path takes only the first array element.

**Why:** validation.js is generic (any field name passes), so the engine's own guards are the only server-side protection against a widget config referencing a derived field where no column exists.

Region↔country classification lives in `shared/countryRegions.js` and deliberately agrees with GSF's `gsf_map_country_lookup` (Middle East/Caucasus/Central Asia → Asia; Mexico+Caribbean → Latin America; North America = CA+US only). A unit suite pins this agreement.

**Region schemes:** the Region dimension supports multiple classification schemes (`app` default, `world_bank` = the Bank's 7 analytical regions). The scheme id rides on the widget's `groupBy.regionScheme`; absent/unknown MUST normalise to `app` so legacy widgets reproduce output byte-for-byte. When an `lmic` filter sits on any `countries`-typed field feeding Region, the bucket is derived from LMIC-resolving countries only, and a row with none produces **no bucket at all** (null, not "Unknown") — mirroring `pruneLmicGroupKeys`. Scheme metadata for the builder picker is published as `regionSchemes` on the source's region systemField.

**Workspace quirk:** running the aggregation engine locally against the pooler/REST with 500-UUID `.in()` lists trips Node's 16KB header limit (`UND_ERR_HEADERS_OVERFLOW`, surfaces as "TypeError: fetch failed" and silently yields empty preference maps because the fetch error is caught). Re-run with `NODE_OPTIONS=--max-http-header-size=131072`. Vercel is unaffected.
