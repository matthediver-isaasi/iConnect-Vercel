import { supabase } from '../../_lib/database.js';
import { tenantFilter } from './permissions.js';
import { getSourceDef, getCustomFieldsForSource } from './sources.js';
import { resolveCountryToIso2, getCountryByCode } from '../../../shared/countries.js';
import {
  deriveRegionBucket,
  deriveRegionBucketList,
  normaliseRegionScheme,
  regionBucketsForScheme,
  REGION_UNKNOWN,
} from '../../../shared/countryRegions.js';
import {
  buildStageMaps,
  mkMatchers,
  canonicalizeKey,
  CANONICAL,
  sortedHistory,
  getStatusFromHistory,
  findFirstTransitionAt,
} from '../../reports/_ddReportHelpers.js';

// Synthetic DD date dimension: "Date moved to stage …". Not a stored column;
// each row's value is derived from its history_log as the timestamp it first
// entered the chosen workflow stage. The chosen stage rides on the
// time-bucket / filter field config (its `stage` property).
const DD_MOVED_TO_STAGE_FIELD = 'moved_to_stage';

const MAX_BUCKETS = 50;
const MAX_GROUPS = 30;
// List widgets render rows in a scrollable pane, so they can afford far more
// groups than a chart — but still cap them so a pathological group-by (e.g.
// free-text field) can't blow up the response.
export const MAX_LIST_GROUPS = 500;
const PAGE_SIZE = 1000;
// Hard ceiling on the number of rows we are willing to scan for a single
// widget before refusing the query. This protects the API from runaway
// computations on huge tables; users who hit it must add filters.
const MAX_TOTAL_ROWS = 50000;
const NUMERIC_TYPES = new Set(['number', 'decimal']);
const NUMERIC_AGGREGATORS = new Set(['sum', 'avg', 'min', 'max']);

/**
 * Run a widget configuration against the database and return chart-ready
 * data. The result shape varies slightly per widget type but always
 * includes a `categories` array (legend) and a `rows` array.
 */
export async function runWidgetConfig(config, tenantId, options = {}) {
  if (!supabase) {
    throw new Error('Database not configured');
  }
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid widget config');
  }

  // Callers pass a larger cap for list widgets; charts keep MAX_GROUPS.
  const maxGroups = Number.isInteger(options.maxGroups) && options.maxGroups > 0
    ? Math.min(options.maxGroups, MAX_LIST_GROUPS)
    : MAX_GROUPS;

  const source = getSourceDef(config.source);
  if (!source) {
    throw new Error(`Unknown source: ${config.source}`);
  }

  // DD Submissions has a bespoke shape (canonicalised workflow_status,
  // joined organisation org_type preference) so it routes through its
  // own aggregator instead of the generic preference-store path.
  if (source.isDd) {
    return runDdWidgetConfig(config, tenantId, source, maxGroups);
  }

  // Form conversion has a bespoke shape (two forms, distinct-entity
  // intersection) so it routes through its own aggregator — the generic
  // measure / group-by / time-bucket machinery does not apply.
  if (source.isConversion) {
    return runConversionWidgetConfig(config, tenantId, source);
  }

  // Event Bookings spans two tables (simple + complex bookings) and has
  // an optional organisation-participation mode, so it routes through a
  // bespoke aggregator that unions both tables tenant-scoped.
  if (source.isBooking) {
    return runBookingWidgetConfig(config, tenantId, source, maxGroups, options);
  }

  const measure = normaliseMeasure(config.measure);
  const groupBy = config.groupBy || null;
  const timeBucket = config.timeBucket || null;

  if (!measure) {
    throw new Error('Measure is required');
  }
  if (groupBy && timeBucket) {
    throw new Error('Choose either group-by or time-bucket, not both');
  }

  // Derived "Region" dimension: classified at query time from the
  // tenant's `countries`-typed preference fields (e.g. "Countries of
  // operation"). There is no stored `region` column, so the field is
  // only valid as a group-by or a filter (both resolved in JS after
  // per-row bucket derivation) — reject measure / time-bucket references
  // up front so a malformed config fails with a clear message instead of
  // a SQL error.
  const regionField = (source.systemFields || []).find(f => f.derived === 'region') || null;
  const isRegionRef = ref => !!regionField
    && !!ref
    && (ref.fieldKind === 'system' || ref.kind === 'system' || (!ref.fieldKind && !ref.kind))
    && ref.field === regionField.name;
  const regionGroupBy = !!(groupBy && groupBy.kind === 'system' && isRegionRef(groupBy));
  const regionFilters = (config.filters || []).filter(isRegionRef);
  if (isRegionRef(measure)
    || (measure.additionalFields || []).some(isRegionRef)
    || (timeBucket && isRegionRef(timeBucket))) {
    throw new Error('Region is a derived dimension and can only be used for grouping or filtering');
  }

  // Other derived dimensions: the member source's "Organisation type"
  // (hydrated from the member's organisation's org_type preference value)
  // and "Active in period" (Yes/No computed from last_activity vs a date
  // range carried on the referencing config as `from`/`to`). Like Region
  // they have no stored column — group-by / series / filters resolve in
  // JS after per-row derivation and must never reach the SQL column
  // selection or the pushed-down PostgREST filters.
  const derivedFieldByName = new Map(
    (source.systemFields || [])
      .filter(f => f.derived && f.derived !== 'region')
      .map(f => [f.name, f]),
  );
  const isDerivedRef = ref => !!ref
    && (ref.fieldKind === 'system' || ref.kind === 'system' || (!ref.fieldKind && !ref.kind))
    && !!ref.field
    && derivedFieldByName.has(ref.field);
  const derivedKindOf = ref => (isDerivedRef(ref) ? derivedFieldByName.get(ref.field).derived : null);
  const derivedGroupKind = groupBy && !regionGroupBy ? derivedKindOf(groupBy) : null;
  const derivedFilters = (config.filters || []).filter(isDerivedRef);
  if (isDerivedRef(measure)
    || (measure.additionalFields || []).some(isDerivedRef)
    || (timeBucket && isDerivedRef(timeBucket))) {
    throw new Error('This field is a derived dimension and can only be used for grouping or filtering');
  }
  // Optional secondary split: `seriesBy` stacks each group-by bucket by the
  // derived "Active in period" dimension so a single widget shows both
  // logged-in and not-logged-in counts per group (e.g. per organisation
  // type). Only that dimension is supported as a series.
  const seriesBy = config.seriesBy || null;
  if (seriesBy) {
    if (derivedKindOf(seriesBy) !== 'active_in_period') {
      throw new Error('Series split is only supported on the "Active in period" dimension');
    }
    if (!groupBy) throw new Error('Series split requires a group-by field');
    if (timeBucket) throw new Error('Series split cannot be combined with a time bucket');
    if (derivedGroupKind === 'active_in_period') {
      throw new Error('Group-by and series split cannot both be "Active in period"');
    }
  }
  const usesOrgType = derivedGroupKind === 'org_type'
    || derivedFilters.some(f => derivedKindOf(f) === 'org_type');
  const usesActive = derivedGroupKind === 'active_in_period'
    || !!seriesBy
    || derivedFilters.some(f => derivedKindOf(f) === 'active_in_period');

  // count and count_distinct accept any field type; numeric aggregators
  // require a numeric field. Reject mismatches up front. This
  // prevents silent string coercion that would otherwise return zero or NaN.
  if (NUMERIC_AGGREGATORS.has(measure.aggregator)) {
    if (!measure.field && !measure.fieldId) {
      throw new Error(`${measure.aggregator} requires a numeric field`);
    }
    const fieldType = await resolveFieldType(source, measure, tenantId);
    if (!fieldType || !NUMERIC_TYPES.has(fieldType)) {
      throw new Error(
        `${measure.aggregator} can only be applied to numeric fields (got ${fieldType || 'unknown'})`,
      );
    }
  }

  // Build column selection: id, plus measure column, plus group/time columns,
  // plus all filter columns. Custom fields require a join to the preference
  // value table (handled separately below).
  const systemColumns = new Set(['id']);
  if (source.timestampField) systemColumns.add(source.timestampField);
  if (measure.field && measure.fieldKind === 'system') {
    systemColumns.add(measure.field);
  }
  // The derived region dimension has no stored column — its per-row value
  // is computed below from preference values, so it must never reach the
  // SQL column selection.
  if (groupBy?.kind === 'system' && !regionGroupBy && !derivedGroupKind) systemColumns.add(groupBy.field);
  // Custom-field timeBucket (e.g. organisation.go_live) does NOT add to the
  // system column set — its value is hydrated via the preference store
  // below, not the base row.
  if (timeBucket?.field && timeBucket.fieldKind !== 'custom') {
    systemColumns.add(timeBucket.field);
  }
  (config.filters || []).forEach(f => {
    // Region / derived-dimension filters are resolved in JS after bucket
    // derivation — derived fields must never reach the SQL column selection.
    if (f.fieldKind === 'system' && f.field && !isRegionRef(f) && !isDerivedRef(f)) systemColumns.add(f.field);
  });
  // Derived dimensions read real columns off the base row:
  // "Organisation type" resolves via the member's organisation id, and
  // "Active in period" reads last_activity.
  if (usesOrgType) systemColumns.add('organization_id');
  if (usesActive) systemColumns.add('last_activity');

  // Resolve any `lmic` operator filters into concrete IN-lists by loading
  // the tenant's saved LMIC country codes once per query. Doing this at
  // query time (rather than baking the codes into the widget config)
  // means LMIC settings edits are reflected in widget output immediately.
  const lmicCodes = needsLmicResolution(config) ? await loadTenantLmicCodes(tenantId) : null;

  // Fetch base rows (tenant scoped + system filters applied directly).
  // Supabase enforces a per-request row cap (default 1000), so we paginate
  // explicitly via .range() instead of relying on .limit(). If the dataset
  // exceeds MAX_TOTAL_ROWS we refuse the query so the user adds filters
  // rather than receiving silently-incomplete numbers.
  const selectColumns = Array.from(systemColumns).join(', ');
  // Region filters have no stored column, so they can't be pushed down to
  // PostgREST — they're applied in JS after per-row bucket derivation.
  const systemFilters = (config.filters || []).filter(
    f => f.fieldKind === 'system' && !isRegionRef(f) && !isDerivedRef(f),
  );
  let workingRows = [];
  for (let from = 0; from < MAX_TOTAL_ROWS; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE - 1, MAX_TOTAL_ROWS - 1);
    let q = supabase.from(source.table).select(selectColumns);
    q = tenantFilter(q, tenantId);
    q = applySystemFilters(q, systemFilters, lmicCodes);
    // Stable ordering is required for .range() pagination — without it
    // PostgREST may skip or repeat rows across pages, silently under- or
    // over-counting once the dataset exceeds one page.
    q = q.order('id', { ascending: true });
    const { data: page, error } = await q.range(from, to);
    if (error) {
      throw new Error(`Source query failed: ${error.message}`);
    }
    if (!page || page.length === 0) break;
    workingRows = workingRows.concat(page);
    // A short page means we've drained the source.
    if (page.length < PAGE_SIZE) break;
    // A full page that fills our scan budget means more rows remain — refuse
    // rather than silently truncate.
    if (workingRows.length >= MAX_TOTAL_ROWS) {
      throw new Error(
        `Widget would scan more than ${MAX_TOTAL_ROWS} rows. ` +
        `Add filters to narrow the dataset.`,
      );
    }
  }

  // Hydrate custom fields (preferences) used by measure / group / filter.
  const customFieldsNeeded = collectCustomFieldIds(config);
  let prefMap = new Map();
  if (customFieldsNeeded.size > 0 && workingRows.length > 0) {
    prefMap = await loadPreferenceValues({
      table: source.preferenceTable,
      fkColumn: source.preferenceFkColumn,
      ids: workingRows.map(r => r.id),
      fieldIds: Array.from(customFieldsNeeded),
    });
  }

  // Identify which of the custom fields touched by this widget are
  // list-typed (multi-pick picklists). The measure, filter AND group-by
  // paths use this to apply list-aware semantics — count_distinct
  // flattens every element across rows, filters match when ANY element
  // satisfies the predicate, and group-by buckets a row under EVERY
  // element (so "orgs per country" agrees with the list page, which
  // matches any element — not just the first).
  const { listFieldIds, countryFieldIds } = await resolveListFieldIds(source, tenantId, customFieldsNeeded);

  // Apply custom-field filters in JS.
  const customFilters = (config.filters || []).filter(f => f.fieldKind === 'custom');
  if (customFilters.length > 0) {
    workingRows = workingRows.filter(row => {
      const prefs = prefMap.get(row.id) || {};
      return customFilters.every(f =>
        matchFilter(prefs[f.fieldId], f, lmicCodes, listFieldIds.has(f.fieldId)),
      );
    });
  }

  // Hydrate the derived Region bucket per row. Every value of every
  // `countries`-typed preference field contributes (the FULL stored list,
  // deliberately bypassing the first-element semantics of valueFor /
  // extractPrimitive): one distinct region → its name, several →
  // "Multi-region", none / unresolvable → "Unknown".
  // The scheme rides on the referencing config (`regionScheme` on the
  // group-by and/or each region filter); absent or unrecognised values
  // fall back to the app scheme so existing widgets reproduce today's
  // output exactly. A group-by and a filter may use different schemes,
  // so buckets are derived once per distinct scheme in play.
  const regionScheme = regionGroupBy ? normaliseRegionScheme(groupBy.regionScheme) : null;
  // "Multi-region" toggle on the region group-by. Default (absent / true)
  // keeps the historical single-bucket behaviour. When explicitly false,
  // an organisation whose countries span several regions is counted once
  // under EACH of those regions instead of once under "Multi-region".
  // Filters are unaffected — they always match the single-bucket value.
  const regionMultiOff = regionGroupBy && groupBy.multiRegion === false;
  const regionSchemesNeeded = new Set();
  if (regionGroupBy) regionSchemesNeeded.add(regionScheme);
  regionFilters.forEach(f => regionSchemesNeeded.add(normaliseRegionScheme(f.regionScheme)));
  // scheme -> Map(rowId -> bucket|null)
  const regionBucketsBySchemes = new Map();
  // Multi-region OFF only: rowId -> array of region keys under the
  // group-by scheme ([] = LMIC-pruned; missing entry = never hydrated,
  // falls back to ["Unknown"] like the single-bucket path).
  let regionKeyListByRow = null;
  if (regionSchemesNeeded.size > 0 && workingRows.length > 0) {
    const allCustomFields = await getCustomFieldsForSource(source, tenantId);
    const regionCountryFieldIds = allCustomFields
      .filter(f => f.fieldType === 'countries')
      .map(f => f.id);
    const regionPrefMap = regionCountryFieldIds.length > 0
      ? await loadPreferenceValues({
          table: source.preferenceTable,
          fkColumn: source.preferenceFkColumn,
          ids: workingRows.map(r => r.id),
          fieldIds: regionCountryFieldIds,
        })
      : new Map();
    // When an `lmic` filter rides on any of the country fields feeding
    // the region dimension, the region is derived ONLY from countries
    // resolving to the tenant's LMIC list. Rows with no LMIC-resolving
    // country produce NO bucket (deriveRegionBucket returns null) — they
    // still count toward the row-level total, mirroring the element-wise
    // pruning of pruneLmicGroupKeys.
    // `not_lmic` inverts this: the region derives ONLY from countries
    // resolving OUTSIDE the tenant LMIC list. Same emptiness rules as
    // elsewhere: `lmic` needs a non-empty list, `not_lmic` doesn't.
    const regionFilterMatches = op => Array.isArray(lmicCodes)
      && (config.filters || []).some(
          f => f.operator === op
            && f.fieldKind === 'custom'
            && regionCountryFieldIds.includes(f.fieldId),
        );
    const regionTenantListMode = (regionFilterMatches('lmic') && lmicCodes.length > 0)
      ? 'lmic'
      : (regionFilterMatches('not_lmic') ? 'not_lmic' : null);
    const regionLmicSet = regionTenantListMode ? new Set(lmicCodes) : null;
    const regionLmicInvert = regionTenantListMode === 'not_lmic';
    for (const scheme of regionSchemesNeeded) {
      const bucketByRow = new Map();
      const collectLists = regionMultiOff && scheme === regionScheme;
      const listByRow = collectLists ? new Map() : null;
      for (const row of workingRows) {
        const prefs = regionPrefMap.get(row.id) || {};
        const countries = [];
        for (const fieldId of regionCountryFieldIds) {
          countries.push(...toList(prefs[fieldId]));
        }
        bucketByRow.set(
          row.id,
          deriveRegionBucket(countries, {
            scheme,
            lmicCodeSet: regionLmicSet,
            lmicInvert: regionLmicInvert,
          }),
        );
        if (listByRow) {
          // Multi-region OFF: the group-by counts this row once under
          // EVERY region its countries touch. [] = LMIC-pruned to
          // nothing (no bucket); filters still use the single-bucket
          // map above.
          listByRow.set(
            row.id,
            deriveRegionBucketList(countries, {
              scheme,
              lmicCodeSet: regionLmicSet,
              lmicInvert: regionLmicInvert,
            }),
          );
        }
      }
      regionBucketsBySchemes.set(scheme, bucketByRow);
      if (listByRow) regionKeyListByRow = listByRow;
    }
  }
  const regionByRowId = regionGroupBy
    ? (regionBucketsBySchemes.get(regionScheme) || null)
    : null;

  // Apply region filters in JS against each row's derived bucket (under
  // the filter's own scheme). An LMIC-pruned row has a null bucket —
  // treated as empty, so it fails `eq`/`in` and matches `is_null`,
  // mirroring how such rows create no group-by bucket.
  if (regionFilters.length > 0) {
    workingRows = workingRows.filter(row =>
      regionFilters.every(f => {
        const bucketByRow = regionBucketsBySchemes.get(normaliseRegionScheme(f.regionScheme));
        const bucket = bucketByRow ? (bucketByRow.get(row.id) ?? null) : null;
        return matchFilter(bucket, f, null, false);
      }),
    );
  }

  // Hydrate the derived "Organisation type" bucket per row: the member's
  // organisation's org_type preference value. Members with no organisation
  // or no stored value bucket under the explicit "Unknown" key.
  let orgTypeByRow = null;
  if (usesOrgType && workingRows.length > 0) {
    orgTypeByRow = await loadOrgTypeBuckets(workingRows, tenantId);
  }
  // Per-ref "Active in period" bucketer: Active when last_activity falls
  // inside the ref's own from/to range, else Inactive (including members
  // who never logged in). The range rides on the referencing config
  // (groupBy / seriesBy / each filter), so different refs may carry
  // different ranges.
  const activeBucketFor = ref => {
    const bounds = activePeriodBounds(ref);
    return row => activeInPeriodBucket(row.last_activity, bounds);
  };
  // Apply derived-dimension filters in JS against each row's bucket.
  if (derivedFilters.length > 0) {
    const matchers = derivedFilters.map(f => {
      if (derivedKindOf(f) === 'org_type') {
        return row => matchFilter(
          orgTypeByRow ? (orgTypeByRow.get(row.id) ?? 'Unknown') : 'Unknown',
          f, null, false,
        );
      }
      const bucketOf = activeBucketFor(f);
      return row => matchFilter(bucketOf(row), f, null, false);
    });
    workingRows = workingRows.filter(row => matchers.every(m => m(row)));
  }

  // Resolve a value for each row. When measure.additionalFields is set
  // (e.g. children_impacted_direct + children_impacted_indirect) the
  // per-row value is the numeric sum of the primary field's value plus
  // every additional field's value — non-numeric / missing values are
  // coerced to 0 so a row with only one of the two fields populated
  // still contributes its known portion.
  const additional = Array.isArray(measure.additionalFields) ? measure.additionalFields : [];
  const toNum = v => {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const measureValueOf = additional.length > 0
    ? row => {
        const primary = toNum(valueFor(row, measure, prefMap));
        return additional.reduce(
          (sum, ref) => sum + toNum(valueFor(row, ref, prefMap)),
          primary,
        );
      }
    : row => valueFor(row, measure, prefMap);
  // When the measure is `count_distinct` over a list-typed custom field
  // (multi-pick picklist), every element in every row's list contributes
  // to the distinct set — not just each row's first element. All other
  // aggregators (count, sum, avg, min, max) keep their per-row scalar
  // contract by going through `measureValueOf`.
  const isListMeasureCD = measure.aggregator === 'count_distinct'
    && measure.fieldKind === 'custom'
    && !!measure.fieldId
    && listFieldIds.has(measure.fieldId);
  // When the same list-typed field is being both LMIC-filtered AND
  // count-distinct'd, normalise each contributed element through the
  // shared name->code resolver and only keep elements that resolve to a
  // tenant LMIC code. This makes the distinct count operate on ISO-2
  // codes rather than raw stored strings, so:
  //   - non-LMIC elements in a row that passed the filter (because some
  //     OTHER element matched) don't get counted; and
  //   - mixed storage like `["Kenya"]` and `["KE"]` across rows collapses
  //     to one distinct entry instead of two.
  // `not_lmic` mirrors this with inverted membership: only elements
  // resolving to a code OUTSIDE the tenant list are counted. Note the
  // `lmic` mode requires a non-empty list (empty = match nothing) while
  // `not_lmic` works with an empty list too (empty = everything is
  // non-LMIC).
  const measureTenantListMode = !isListMeasureCD || !Array.isArray(lmicCodes)
    ? null
    : ((config.filters || []).some(
          f => f.operator === 'lmic'
            && f.fieldKind === 'custom'
            && f.fieldId === measure.fieldId,
        ) && lmicCodes.length > 0
        ? 'lmic'
        : ((config.filters || []).some(
              f => f.operator === 'not_lmic'
                && f.fieldKind === 'custom'
                && f.fieldId === measure.fieldId,
            )
            ? 'not_lmic'
            : null));
  const lmicCodeSet = measureTenantListMode ? new Set(lmicCodes) : null;
  const pushMeasureValues = isListMeasureCD
    ? (target, row) => {
        const raw = (prefMap.get(row.id) || {})[measure.fieldId];
        for (const v of toList(raw)) {
          if (lmicCodeSet) {
            const code = resolveCountryToIso2(v);
            const inSet = code !== null && lmicCodeSet.has(code);
            const keep = code !== null
              && (measureTenantListMode === 'lmic' ? inSet : !inSet);
            if (keep) target.push(code);
          } else {
            target.push(v);
          }
        }
      }
    : (target, row) => target.push(measureValueOf(row));
  // Group-by key(s) per row. For list-typed (multi-pick) custom fields a
  // row contributes to EVERY element's bucket — an org operating in
  // ["Kenya", "India"] must count under both countries, matching the
  // any-element semantics of the list-page filters. Rows with an empty
  // list keep the single "Unspecified" bucket. Elements are de-duplicated
  // per row so a repeated value can't double-count one row in a bucket.
  const isListGroupBy = !!(groupBy
    && !regionGroupBy
    && (groupBy.fieldKind === 'custom' || groupBy.kind === 'custom')
    && groupBy.fieldId
    && listFieldIds.has(groupBy.fieldId));
  // When the SAME field carrying an `lmic` filter is also the group-by
  // dimension, prune group keys element-wise: each element is resolved to
  // its ISO-2 code and only tenant LMIC codes survive. The normalised code
  // is used as the bucket key so mixed storage ("Kenya" vs "KE") collapses
  // into one bucket; codes are mapped back to display names in the
  // response. Rows whose list has no LMIC element create NO bucket (they
  // still count toward the row-level total — the filter already admitted
  // them because SOME element matched — but their non-LMIC countries must
  // not appear as breakdown buckets, and they must not fall into
  // "Unspecified" either).
  // `not_lmic` on the group-by field applies the same element-wise
  // pruning with inverted membership (only non-LMIC codes survive as
  // bucket keys). Same list-emptiness rules as the measure path above.
  const groupByFilterMatches = op => !!(groupBy
    && !regionGroupBy
    && Array.isArray(lmicCodes)
    && (config.filters || []).some(f => {
        if (f.operator !== op) return false;
        if (groupBy.fieldKind === 'custom' || groupBy.kind === 'custom') {
          return f.fieldKind === 'custom' && !!groupBy.fieldId && f.fieldId === groupBy.fieldId;
        }
        return f.fieldKind === 'system' && !!groupBy.field && f.field === groupBy.field;
      }));
  const groupByTenantListMode = (groupByFilterMatches('lmic') && lmicCodes.length > 0)
    ? 'lmic'
    : (groupByFilterMatches('not_lmic') ? 'not_lmic' : null);
  const lmicFilterOnGroupBy = !!groupByTenantListMode;
  const lmicGroupCodeSet = lmicFilterOnGroupBy ? new Set(lmicCodes) : null;
  const lmicGroupKeys = raw => pruneLmicGroupKeys(raw, lmicGroupCodeSet, {
    invert: groupByTenantListMode === 'not_lmic',
  });
  // Country-shaped group-bys (system `country` column, or custom
  // country/countries fields) are normalised through the shared country
  // resolver even WITHOUT an LMIC filter: each element resolves to its
  // ISO-2 code for bucketing (so "Kenya" and "KE" merge) and the code is
  // mapped back to the display name in the response. Unresolvable values
  // keep their raw string as the bucket key so no data is hidden.
  const isCountryGroupBy = !!(groupBy
    && !regionGroupBy
    && ((groupBy.fieldKind === 'custom' || groupBy.kind === 'custom')
        ? (!!groupBy.fieldId && countryFieldIds.has(groupBy.fieldId))
        : !!(source.systemFields || []).find(
            f => f.name === groupBy.field && f.isCountry,
          )));
  // Reference-typed system group-bys (e.g. member.role_id → role) store
  // raw ids; charts must show human-readable names. Resolve the id→name
  // mapping ONCE up front (tenant-scoped) and bucket rows directly under
  // the resolved name, so drilldown — which re-runs this same pipeline
  // and matches on the final key — stays consistent. Missing/deleted
  // references bucket under "Unknown"; empty values keep the shared
  // "Unspecified" bucket. Fields without a referenceTable (or country /
  // LMIC / region shaped group-bys) are untouched.
  const referenceFieldDef = (groupBy
    && !regionGroupBy
    && !derivedGroupKind
    && !lmicFilterOnGroupBy
    && !isCountryGroupBy
    && !(groupBy.fieldKind === 'custom' || groupBy.kind === 'custom')
    && groupBy.field)
    ? (source.systemFields || []).find(
        f => f.name === groupBy.field && f.type === 'reference' && f.referenceTable,
      ) || null
    : null;
  let referenceNameById = null;
  if (referenceFieldDef && workingRows.length > 0) {
    referenceNameById = await loadReferenceNames(
      referenceFieldDef.referenceTable,
      workingRows.map(r => r[groupBy.field]),
      tenantId,
    );
  }
  const groupKeysOf = groupBy
    ? (regionGroupBy
        ? row => {
            // Multi-region OFF: the row buckets once under every region
            // its countries touch ([] = LMIC-pruned to nothing).
            if (regionMultiOff) {
              return regionKeyListByRow && regionKeyListByRow.has(row.id)
                ? regionKeyListByRow.get(row.id)
                : [REGION_UNKNOWN];
            }
            // null = LMIC-pruned to nothing → the row creates NO bucket
            // (it still counts toward the total). A missing map entry
            // (never hydrated) keeps the legacy "Unknown" fallback.
            const bucket = regionByRowId && regionByRowId.has(row.id)
              ? regionByRowId.get(row.id)
              : REGION_UNKNOWN;
            return bucket === null ? [] : [bucket];
          }
        : (derivedGroupKind === 'org_type'
        ? row => [orgTypeByRow ? (orgTypeByRow.get(row.id) ?? 'Unknown') : 'Unknown']
        : derivedGroupKind === 'active_in_period'
        ? (() => {
            const bucketOf = activeBucketFor(groupBy);
            return row => [bucketOf(row)];
          })()
        : (lmicFilterOnGroupBy
            ? ((groupBy.fieldKind === 'custom' || groupBy.kind === 'custom')
                ? row => lmicGroupKeys((prefMap.get(row.id) || {})[groupBy.fieldId])
                : row => lmicGroupKeys(row[groupBy.field]))
            : (isCountryGroupBy
                ? ((groupBy.fieldKind === 'custom' || groupBy.kind === 'custom')
                    ? row => countryGroupKeys((prefMap.get(row.id) || {})[groupBy.fieldId])
                    : row => countryGroupKeys(row[groupBy.field]))
                : (referenceNameById
                    ? row => [referenceGroupKey(row[groupBy.field], referenceNameById)]
                    : (isListGroupBy
                        ? row => listGroupKeys((prefMap.get(row.id) || {})[groupBy.fieldId])
                        : row => [normaliseKey(valueFor(row, groupBy, prefMap))]))))))
    : null;
  // timeBucket on a custom date field reads through the preference map; for
  // system date columns it reads the value directly off the base row.
  const timeKeyOf = timeBucket
    ? row => {
        const raw = timeBucket.fieldKind === 'custom'
          ? extractPrimitive((prefMap.get(row.id) || {})[timeBucket.fieldId])
          : row[timeBucket.field];
        return bucketTimestamp(raw, timeBucket.granularity);
      }
    : null;

  // No grouping — single value (count, sum, etc.).
  if (!groupBy && !timeBucket) {
    const values = [];
    for (const row of workingRows) pushMeasureValues(values, row);
    const value = aggregate(values, measure.aggregator);
    return {
      type: 'scalar',
      total: workingRows.length,
      value,
      rows: [{ key: 'total', value }],
    };
  }

  // Group-by aggregation with a series split: each group bucket is further
  // split by the derived "Active in period" dimension, producing one row
  // per group key with a column per series (Active / Inactive) plus a
  // `value` total so single-series consumers (list, pie, CSV export)
  // degrade gracefully. `categories` carries the series order for the
  // stacked bar renderer.
  if (groupBy && seriesBy) {
    const seriesKeyOf = activeBucketFor(seriesBy);
    const categories = ['Active', 'Inactive'];
    const buckets = new Map(); // key -> { Active: [], Inactive: [] }
    const bucketRowIds = options.collectRowIds ? new Map() : null;
    workingRows.forEach(row => {
      const sKey = seriesKeyOf(row);
      for (const key of groupKeysOf(row)) {
        if (!buckets.has(key)) buckets.set(key, { Active: [], Inactive: [] });
        pushMeasureValues(buckets.get(key)[sKey], row);
        if (bucketRowIds) {
          if (!bucketRowIds.has(key)) bucketRowIds.set(key, new Set());
          bucketRowIds.get(key).add(row.id);
        }
      }
    });
    const grouped = Array.from(buckets.entries()).map(([key, series]) => {
      const perSeries = {};
      categories.forEach(c => { perSeries[c] = aggregate(series[c], measure.aggregator); });
      return {
        key,
        value: categories.reduce((acc, c) => acc + (Number(perSeries[c]) || 0), 0),
        ...perSeries,
        ...(bucketRowIds ? { rowIds: Array.from(bucketRowIds.get(key) || []) } : {}),
      };
    });
    sortGroupedRows(grouped);
    if (grouped.length > maxGroups) {
      throw new Error(
        `Group-by produced ${grouped.length} groups (max ${maxGroups}). ` +
        `Add a filter or pick a less granular field.`,
      );
    }
    return {
      type: 'group',
      total: workingRows.length,
      categories,
      rows: grouped,
    };
  }

  // Group-by aggregation.
  if (groupBy) {
    const buckets = new Map();
    // Drill-down support: when the caller asks for it, remember which
    // base-row ids fed each bucket so a widget click can open the CRM
    // list filtered to exactly those records. Ids are de-duplicated per
    // bucket (a list-typed group-by can yield repeated keys per row).
    const bucketRowIds = options.collectRowIds ? new Map() : null;
    workingRows.forEach(row => {
      for (const key of groupKeysOf(row)) {
        if (!buckets.has(key)) buckets.set(key, []);
        pushMeasureValues(buckets.get(key), row);
        if (bucketRowIds) {
          if (!bucketRowIds.has(key)) bucketRowIds.set(key, new Set());
          bucketRowIds.get(key).add(row.id);
        }
      }
    });
    const grouped = Array.from(buckets.entries())
      .map(([key, values]) => ({
        // LMIC-pruned and country-normalised bucket keys are ISO-2 codes;
        // map them back to human-readable country names for charts/tables.
        // Unresolvable raw strings pass through untouched.
        key: (lmicFilterOnGroupBy || isCountryGroupBy)
          ? (getCountryByCode(key)?.name || key)
          : key,
        value: aggregate(values, measure.aggregator),
        ...(bucketRowIds
          ? { rowIds: Array.from(bucketRowIds.get(key) || []) }
          : {}),
      }));
    // Region group-bys with an EXPLICIT scheme sort rows in the scheme's
    // stable display order (regions, then Multi-region, then Unknown) so
    // chart/legend order doesn't shuffle with the data. Scheme-less
    // (legacy) configs — and every other group-by — keep the historical
    // value-descending sort so existing widgets' output is unchanged.
    const regionBucketOrder = regionGroupBy && groupBy.regionScheme
      ? regionBucketsForScheme(regionScheme)
      : null;
    sortGroupedRows(grouped, regionBucketOrder);
    if (grouped.length > maxGroups) {
      throw new Error(
        `Group-by produced ${grouped.length} groups (max ${maxGroups}). ` +
        `Add a filter or pick a less granular field.`,
      );
    }
    return {
      type: 'group',
      total: workingRows.length,
      categories: ['value'],
      rows: grouped,
    };
  }

  // Time-bucket aggregation.
  const buckets = new Map();
  workingRows.forEach(row => {
    const key = timeKeyOf(row);
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    pushMeasureValues(buckets.get(key), row);
  });
  return {
    type: 'time',
    total: workingRows.length,
    categories: ['value'],
    rows: finalizeTimeRows(buckets, timeBucket, measure.aggregator, config.cumulative),
    granularity: timeBucket.granularity,
  };
}

/**
 * In-place sort for grouped widget rows. Without a `regionBucketOrder`
 * this is the historical value-descending sort used by every group-by.
 * With one (a scheme's bucket list from regionBucketsForScheme), rows
 * sort by their bucket's position in that list — regions in stable
 * display order, then Multi-region, then Unknown — with unexpected keys
 * last (value-descending among themselves). Exported for tests.
 */
/**
 * Parses the from/to date range carried on a config ref (groupBy /
 * seriesBy / filter) for the derived "Active in period" dimension.
 * Date-only strings expand to the full day (from = start of day,
 * to = end of day, UTC). At least one valid bound is required.
 */
export function activePeriodBounds(ref) {
  const parse = (raw, endOfDay) => {
    if (!raw || typeof raw !== 'string') return null;
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
      : raw;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t;
  };
  const from = parse(ref?.from, false);
  const to = parse(ref?.to, true);
  if (from === null && to === null) {
    throw new Error('Pick a date range for the "Active in period" field.');
  }
  return { from, to };
}

/**
 * Buckets a member's last_activity timestamp against a period: 'Active'
 * when it falls inside the bounds, 'Inactive' otherwise — including
 * members who never logged in (null last_activity).
 */
export function activeInPeriodBucket(lastActivity, bounds) {
  if (!lastActivity) return 'Inactive';
  const t = Date.parse(lastActivity);
  if (Number.isNaN(t)) return 'Inactive';
  if (bounds.from !== null && t < bounds.from) return 'Inactive';
  if (bounds.to !== null && t > bounds.to) return 'Inactive';
  return 'Active';
}

/**
 * Normalises a parsed org_type preference value into a bucket key.
 * Empty / missing values collapse to the explicit "Unknown" bucket.
 */
export function orgTypeBucketKey(value) {
  const v = extractPrimitive(value);
  if (v === null || v === undefined) return 'Unknown';
  const s = String(v).trim();
  return s === '' ? 'Unknown' : s;
}

/**
 * Resolves the derived "Organisation type" bucket for each base row: the
 * row's organisation's org_type preference value (org-scoped dropdown),
 * mirroring how the DD submissions source hydrates it. Every row starts
 * in "Unknown"; rows whose organisation has a stored value overwrite it.
 * Query failures throw — silently-missing values would mis-bucket
 * members under "Unknown".
 */
async function loadOrgTypeBuckets(rows, tenantId) {
  const map = new Map();
  rows.forEach(r => map.set(r.id, 'Unknown'));
  const orgIds = Array.from(new Set(rows.map(r => r.organization_id).filter(Boolean)));
  if (orgIds.length === 0) return map;
  const { data: field, error: fieldErr } = await supabase
    .from('preference_field')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization')
    .eq('name', 'org_type')
    .maybeSingle();
  if (fieldErr) throw new Error(`org_type field lookup failed: ${fieldErr.message}`);
  if (!field?.id) return map;
  const valueByOrg = new Map();
  const CHUNK = 200;
  for (let i = 0; i < orgIds.length; i += CHUNK) {
    const slice = orgIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('organization_preference_value')
      .select('organization_id, value')
      .eq('field_id', field.id)
      .in('organization_id', slice);
    if (error) throw new Error(`org_type value lookup failed: ${error.message}`);
    (data || []).forEach(p => {
      valueByOrg.set(p.organization_id, orgTypeBucketKey(parsePreferenceValue(p.value)));
    });
  }
  rows.forEach(r => {
    if (r.organization_id && valueByOrg.has(r.organization_id)) {
      map.set(r.id, valueByOrg.get(r.organization_id));
    }
  });
  return map;
}

export function sortGroupedRows(rows, regionBucketOrder = null) {
  if (!regionBucketOrder) {
    return rows.sort((a, b) => b.value - a.value);
  }
  const indexOf = key => {
    const i = regionBucketOrder.indexOf(key);
    return i === -1 ? regionBucketOrder.length : i;
  };
  return rows.sort(
    (a, b) => indexOf(a.key) - indexOf(b.key) || b.value - a.value,
  );
}

// Transform sorted per-bucket rows into a running total: each row's value
// becomes the sum of its own aggregate plus every preceding bucket. Used by
// time-bucketed line widgets when `config.cumulative` is enabled so the chart
// plots a monotonically rising total instead of per-bucket values.
function applyCumulative(rows) {
  let runningTotal = 0;
  return rows.map(row => {
    runningTotal += Number(row.value) || 0;
    return { ...row, value: runningTotal };
  });
}

function needsLmicResolution(config) {
  return (config.filters || []).some(f => f.operator === 'lmic' || f.operator === 'not_lmic');
}

// Loading (with lazy World Bank seed) now lives in the shared helper so the
// form submit-control enforcement (Task #3477) can never drift from the
// dashboard's LMIC semantics.
async function loadTenantLmicCodes(tenantId) {
  const { loadTenantLmicCodes: sharedLoad } = await import('../../_lib/tenantLmicCodes.js');
  return sharedLoad(supabase, tenantId);
}

async function resolveFieldType(source, ref, tenantId) {
  if (ref.fieldKind === 'system' && ref.field) {
    const def = (source.systemFields || []).find(f => f.name === ref.field);
    return def?.type || null;
  }
  if (ref.fieldKind === 'custom' && ref.fieldId) {
    const customFields = await getCustomFieldsForSource(source, tenantId);
    const def = customFields.find(f => f.id === ref.fieldId);
    return def?.type || null;
  }
  return null;
}

// ---------------------------------------------------------------------------

function normaliseMeasure(raw) {
  if (!raw) {
    return { aggregator: 'count', field: null, fieldKind: null, fieldId: null, additionalFields: [] };
  }
  const aggregator = (raw.aggregator || 'count').toLowerCase();
  // Keep this allow-list in sync with measureSchema in validation.js.
  if (!['count', 'count_distinct', 'sum', 'avg', 'min', 'max'].includes(aggregator)) {
    throw new Error(`Unsupported aggregator: ${aggregator}`);
  }
  // additionalFields lets a single measure sum across multiple fields
  // per row before the aggregator runs across rows (e.g. children_impacted
  // = direct + indirect). Drop entries that lack a field reference so a
  // malformed config can't crash the engine.
  const additionalFields = Array.isArray(raw.additionalFields)
    ? raw.additionalFields
        .filter(f => f && (f.field || f.fieldId))
        .map(f => ({
          field: f.field || null,
          fieldKind: f.fieldKind || null,
          fieldId: f.fieldId || null,
        }))
    : [];
  return {
    aggregator,
    field: raw.field || null,
    fieldKind: raw.fieldKind || null,
    fieldId: raw.fieldId || null,
    additionalFields,
  };
}

function applySystemFilters(query, filters, lmicCodes) {
  for (const f of filters) {
    if (!f.field) continue;
    switch (f.operator) {
      case 'lmic': {
        // LMIC operator expands to "field IN (tenant codes)". We treat an
        // empty list as "match nothing" — returning every row would be a
        // surprising no-op when the tenant has cleared their LMIC list.
        const codes = Array.isArray(lmicCodes) ? lmicCodes : [];
        query = query.in(f.field, codes.length > 0 ? codes : ['__never__']);
        break;
      }
      case 'not_lmic': {
        // Inverse of `lmic`: "field NOT IN (tenant codes)". SQL NOT IN
        // already excludes NULLs, but we also exclude them explicitly so
        // "no country recorded" never counts as a non-LMIC country. An
        // empty tenant list means every recorded country is non-LMIC.
        const codes = Array.isArray(lmicCodes) ? lmicCodes : [];
        if (codes.length > 0) {
          query = query.not(f.field, 'in', `(${codes.map(c => `"${c}"`).join(',')})`);
        }
        query = query.not(f.field, 'is', null);
        break;
      }
      case 'eq':
        query = query.eq(f.field, f.value);
        break;
      case 'neq':
        query = query.neq(f.field, f.value);
        break;
      case 'gt':
        query = query.gt(f.field, f.value);
        break;
      case 'gte':
        query = query.gte(f.field, f.value);
        break;
      case 'lt':
        query = query.lt(f.field, f.value);
        break;
      case 'lte':
        query = query.lte(f.field, f.value);
        break;
      case 'in':
        if (Array.isArray(f.value)) query = query.in(f.field, f.value);
        break;
      case 'contains':
        if (f.value !== null && f.value !== undefined && f.value !== '') {
          query = query.ilike(f.field, `%${String(f.value)}%`);
        }
        break;
      case 'is_null':
        query = query.is(f.field, null);
        break;
      case 'is_not_null':
        query = query.not(f.field, 'is', null);
        break;
      default:
        break;
    }
  }
  return query;
}

function collectCustomFieldIds(config) {
  const ids = new Set();
  if (config.measure?.fieldKind === 'custom' && config.measure.fieldId) {
    ids.add(config.measure.fieldId);
  }
  // additionalFields entries (multi-field sum) also need hydration.
  (config.measure?.additionalFields || []).forEach(ref => {
    if (ref.fieldKind === 'custom' && ref.fieldId) ids.add(ref.fieldId);
  });
  if (config.groupBy?.kind === 'custom' && config.groupBy.fieldId) {
    ids.add(config.groupBy.fieldId);
  }
  if (config.timeBucket?.fieldKind === 'custom' && config.timeBucket.fieldId) {
    ids.add(config.timeBucket.fieldId);
  }
  (config.filters || []).forEach(f => {
    if (f.fieldKind === 'custom' && f.fieldId) ids.add(f.fieldId);
  });
  return ids;
}

// Exported for tests: `client` defaults to the real supabase client and can
// be replaced with a stub that simulates PostgREST's 1000-row response cap.
export async function loadPreferenceValues({ table, fkColumn, ids, fieldIds, client = supabase }) {
  const map = new Map();
  if (ids.length === 0 || fieldIds.length === 0) return map;
  // Chunk the ids list to avoid hitting URL length limits.
  const chunk = 500;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    // A single chunk can hold more preference rows than PostgREST's
    // 1000-row response cap (500 ids x several fields), so paginate each
    // chunk explicitly with .range(). Stable ordering on the (fk, field)
    // pair — unique per row — is required or pages may skip/repeat rows.
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await client
        .from(table)
        .select(`${fkColumn}, field_id, value`)
        .in(fkColumn, slice)
        .in('field_id', fieldIds)
        .order(fkColumn, { ascending: true })
        .order('field_id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        // Fail loudly: a silently-missing preference value makes custom
        // filters wrongly exclude rows, i.e. an under-count.
        throw new Error(`Preference value query failed: ${error.message}`);
      }
      (data || []).forEach(row => {
        const ownerId = row[fkColumn];
        if (!map.has(ownerId)) map.set(ownerId, {});
        map.get(ownerId)[row.field_id] = parsePreferenceValue(row.value);
      });
      if (!data || data.length < PAGE_SIZE) break;
    }
  }
  return map;
}

function parsePreferenceValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { return trimmed; }
  }
  return trimmed;
}

function valueFor(row, ref, prefMap) {
  if (!ref) return null;
  if (ref.fieldKind === 'custom' || ref.kind === 'custom') {
    const prefs = prefMap.get(row.id) || {};
    return extractPrimitive(prefs[ref.fieldId]);
  }
  return row[ref.field];
}

function extractPrimitive(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return value.value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const first = value[0];
    return typeof first === 'object' && first?.value !== undefined ? first.value : first;
  }
  return value;
}

// Flatten a hydrated preference value into a plain array of primitives.
// Used by the list-aware paths (count_distinct expansion + filter "any
// element matches" semantics) so a multi-pick custom field contributes
// every selection rather than only the first. Empty / missing inputs
// produce []. A scalar input is wrapped into a single-element array so
// callers can treat list and non-list values uniformly when needed.
function toList(value) {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (item === null || item === undefined || item === '') continue;
      const v = (typeof item === 'object' && 'value' in item) ? item.value : item;
      if (v === null || v === undefined || v === '') continue;
      out.push(v);
    }
    return out;
  }
  if (typeof value === 'object' && 'value' in value) {
    const v = value.value;
    return v === null || v === undefined || v === '' ? [] : [v];
  }
  return [value];
}

// Look up which of the custom field ids referenced by this widget are
// list-typed. We re-read the full custom-field catalogue for the source
// (cheap, single round-trip) rather than caching across calls because
// admins can flip a field's type and we want widgets to reflect that
// without a server restart.
async function resolveListFieldIds(source, tenantId, neededIds) {
  const empty = { listFieldIds: new Set(), countryFieldIds: new Set() };
  if (!neededIds || neededIds.size === 0) return empty;
  const fields = await getCustomFieldsForSource(source, tenantId);
  const listFieldIds = new Set();
  // Country-shaped custom fields (single-pick `country` or multi-pick
  // `countries`): their group-by buckets are normalised through the
  // shared country resolver so name/code storage variants merge.
  const countryFieldIds = new Set();
  for (const f of fields) {
    if (!neededIds.has(f.id)) continue;
    if (f.type === 'list') listFieldIds.add(f.id);
    if (f.fieldType === 'country' || f.fieldType === 'countries') countryFieldIds.add(f.id);
  }
  return { listFieldIds, countryFieldIds };
}

// Bucket keys for a row whose group-by field is list-typed (multi-pick):
// one key per distinct element so the row counts under every value it
// carries; empty/missing lists fall into the single "Unspecified" bucket.
// Exported for tests.
export function listGroupKeys(raw) {
  const keys = [...new Set(toList(raw).map(normaliseKey))];
  return keys.length > 0 ? keys : ['Unspecified'];
}

/**
 * Bucket keys for a country-shaped group-by field (system `country`
 * column or custom country/countries field) when NO LMIC filter is
 * applied. Each element (list or scalar) is resolved to its ISO-2 code
 * so mixed storage ("Kenya" vs "KE") merges into one bucket; the code is
 * mapped back to a display name in the response. Values that don't
 * resolve to a known country keep their raw string as the bucket key —
 * no data is hidden. Empty/missing values fall into "Unspecified".
 * Exported for tests.
 */
export function countryGroupKeys(raw) {
  const keys = [];
  for (const v of toList(raw)) {
    const code = resolveCountryToIso2(v);
    const key = code !== null ? code : normaliseKey(v);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys.length > 0 ? keys : ['Unspecified'];
}

/**
 * Element-wise LMIC pruning for group-by keys. Used when the group-by
 * field is the SAME field carrying an `lmic` filter: each element of the
 * row's value (list or scalar) is resolved to its ISO-2 code and only
 * codes present in the tenant's LMIC set survive. The normalised code is
 * the bucket key, so mixed storage ("Kenya" vs "KE") merges into one
 * bucket. Rows with no surviving element return [] — NO "Unspecified"
 * bucket — because the row already passed the filter via some other
 * element and its non-LMIC countries must not surface as buckets.
 */
export function pruneLmicGroupKeys(raw, lmicCodeSet, options = {}) {
  const { invert = false } = options || {};
  if (!lmicCodeSet || (!invert && lmicCodeSet.size === 0)) return [];
  const codes = [];
  for (const v of toList(raw)) {
    const code = resolveCountryToIso2(v);
    if (code === null) continue;
    const inSet = lmicCodeSet.has(code);
    if ((invert ? !inSet : inSet) && !codes.includes(code)) {
      codes.push(code);
    }
  }
  return codes;
}

/**
 * Bucket key for a reference-typed system group-by (raw id column, e.g.
 * member.role_id). Empty values keep the shared "Unspecified" bucket;
 * ids missing from the resolved map (deleted / cross-tenant rows) bucket
 * under "Unknown" instead of leaking the raw UUID. Exported for tests.
 */
export function referenceGroupKey(rawId, nameById) {
  if (rawId === null || rawId === undefined || rawId === '') return 'Unspecified';
  const name = nameById.get(String(rawId));
  return name !== undefined && name !== null && name !== '' ? name : 'Unknown';
}

/**
 * Loads the id→name mapping for a reference table, tenant-scoped and
 * restricted to the ids actually present in the working rows. Chunked
 * to stay under PostgREST's IN-list limits. A lookup failure returns an
 * empty map (keys fall back to "Unknown") rather than failing the widget.
 */
async function loadReferenceNames(table, rawIds, tenantId) {
  const ids = Array.from(
    new Set(rawIds.filter(v => v !== null && v !== undefined && v !== '').map(String)),
  );
  const nameById = new Map();
  if (ids.length === 0) return nameById;
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    let q = supabase.from(table).select('id, name').in('id', chunk);
    q = tenantFilter(q, tenantId);
    const { data, error } = await q;
    if (error) {
      console.error(
        `[Dashboard Aggregation] Failed to resolve ${table} names:`,
        error.message,
      );
      return nameById;
    }
    for (const row of data || []) {
      if (row?.id !== null && row?.id !== undefined) {
        nameById.set(String(row.id), row.name ?? null);
      }
    }
  }
  return nameById;
}

function normaliseKey(value) {
  if (value === null || value === undefined || value === '') return 'Unspecified';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function aggregate(values, aggregator) {
  if (aggregator === 'count') {
    return values.length;
  }
  if (aggregator === 'count_distinct') {
    // Distinct count over non-empty values. Stringification keeps the
    // semantics consistent across system columns (which can return any
    // primitive) and custom preference values (which often arrive as
    // already-string JSONB extractions).
    const seen = new Set();
    for (const v of values) {
      if (v === null || v === undefined) continue;
      const s = String(v).trim();
      if (s === '') continue;
      seen.add(s.toUpperCase());
    }
    return seen.size;
  }
  const numeric = values
    .map(v => (v === null || v === undefined || v === '' ? null : Number(v)))
    .filter(v => v !== null && !Number.isNaN(v));
  if (numeric.length === 0) return 0;
  switch (aggregator) {
    case 'sum': return numeric.reduce((a, b) => a + b, 0);
    case 'avg': return numeric.reduce((a, b) => a + b, 0) / numeric.length;
    case 'min': return Math.min(...numeric);
    case 'max': return Math.max(...numeric);
    default: return numeric.length;
  }
}

// Coerce a value for ordered comparison. ISO-style date strings compare
// by their parsed timestamp so a custom date field filter like
// `go_live >= '2026-01-01T00:00:00.000Z'` works correctly — a previous
// implementation used Number() on both sides which produced NaN and
// silently dropped every row.
function toComparable(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    // Detect anything that looks like a date string (full ISO or
    // calendar date) before falling back to numeric coercion.
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function compare(value, filterValue, op) {
  const a = toComparable(value);
  const b = toComparable(filterValue);
  if (a === null || b === null) return false;
  switch (op) {
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    default: return false;
  }
}

export function matchFilter(rawValue, filter, lmicCodes, isList = false) {
  // List-typed (multi-pick) custom fields: a row qualifies when ANY
  // element of the list satisfies the predicate (for `lmic`, `eq`,
  // `neq`, `in`, `contains`). `is_null` becomes "list is missing or
  // empty"; `is_not_null` is the inverse. Ordered comparisons
  // (`gt`/`gte`/`lt`/`lte`) aren't meaningful on multi-pick picklists,
  // so they fall through to the scalar (first-element) path.
  if (isList) {
    const elements = toList(rawValue);
    switch (filter.operator) {
      case 'is_null': return elements.length === 0;
      case 'is_not_null': return elements.length > 0;
      case 'lmic': {
        const codes = Array.isArray(lmicCodes) ? lmicCodes : [];
        if (codes.length === 0) return false;
        // Stored values may be ISO-2 codes (system `country` column) or
        // free-text country names (custom multi-pick fields). Normalise
        // each element through the shared name->code resolver before
        // checking membership; unresolved values simply don't match.
        return elements.some(v => {
          const code = resolveCountryToIso2(v);
          return code !== null && codes.includes(code);
        });
      }
      case 'not_lmic': {
        // Inverse of `lmic`: matches when ANY element resolves to a
        // country OUTSIDE the tenant list. Unresolvable values don't
        // match (symmetric with `lmic`, which also drops them) — a value
        // we can't identify as a country is never silently counted as
        // non-LMIC. An empty tenant list means every resolvable country
        // is non-LMIC.
        const codes = Array.isArray(lmicCodes) ? lmicCodes : [];
        return elements.some(v => {
          const code = resolveCountryToIso2(v);
          return code !== null && !codes.includes(code);
        });
      }
      case 'eq':
        return elements.some(v => String(v ?? '') === String(filter.value ?? ''));
      case 'neq':
        return elements.some(v => String(v ?? '') !== String(filter.value ?? ''));
      case 'in': {
        if (!Array.isArray(filter.value)) return false;
        const want = filter.value.map(String);
        return elements.some(v => want.includes(String(v ?? '')));
      }
      case 'contains': {
        if (filter.value === null || filter.value === undefined || filter.value === '') return true;
        const needle = String(filter.value).toLowerCase();
        return elements.some(v => String(v ?? '').toLowerCase().includes(needle));
      }
      default:
        // Fall through to scalar path for ordered comparisons.
        break;
    }
  }
  const value = extractPrimitive(rawValue);
  switch (filter.operator) {
    case 'lmic': {
      const codes = Array.isArray(lmicCodes) ? lmicCodes : [];
      if (codes.length === 0) return false;
      // Resolve through the shared name->code helper so free-text custom
      // country fields (storing names like "Kenya") match alongside the
      // system `country` column (storing ISO-2 codes like "KE"). Values
      // that don't resolve to a known country don't match.
      const code = resolveCountryToIso2(value);
      return code !== null && codes.includes(code);
    }
    case 'not_lmic': {
      // Inverse of `lmic` on scalar values: the resolved code must fall
      // OUTSIDE the tenant list. Unresolvable values never match (same
      // as `lmic`) so junk strings aren't counted as non-LMIC countries.
      const codes = Array.isArray(lmicCodes) ? lmicCodes : [];
      const code = resolveCountryToIso2(value);
      return code !== null && !codes.includes(code);
    }
    case 'eq': return String(value ?? '') === String(filter.value ?? '');
    case 'neq': return String(value ?? '') !== String(filter.value ?? '');
    case 'gt': return compare(value, filter.value, 'gt');
    case 'gte': return compare(value, filter.value, 'gte');
    case 'lt': return compare(value, filter.value, 'lt');
    case 'lte': return compare(value, filter.value, 'lte');
    case 'in':
      if (!Array.isArray(filter.value)) return false;
      return filter.value.map(String).includes(String(value ?? ''));
    case 'contains':
      if (filter.value === null || filter.value === undefined || filter.value === '') return true;
      return String(value ?? '').toLowerCase().includes(String(filter.value).toLowerCase());
    case 'is_null': return value === null || value === undefined || value === '';
    case 'is_not_null': return !(value === null || value === undefined || value === '');
    default: return true;
  }
}

/**
 * Resolves a time-bucket rolling window ({ amount, unit }) to its UTC start
 * date, aligned to the start of the unit period so full buckets are shown
 * (e.g. "last 12 months" starts at the 1st of the month 11 months ago —
 * the current, partial period counts as one of the X). Returns null for
 * absent/invalid windows so legacy configs behave as "all time".
 * Exported for tests.
 */
export function resolveTimeWindowStart(win, now = new Date()) {
  if (!win || typeof win !== 'object') return null;
  const amount = Math.floor(Number(win.amount));
  if (!Number.isFinite(amount) || amount < 1) return null;
  const back = amount - 1;
  switch (win.unit) {
    case 'day':
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));
    case 'week': {
      const day = now.getUTCDay();
      const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1);
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), diff - back * 7));
    }
    case 'month':
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    case 'quarter': {
      const qStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
      return new Date(Date.UTC(now.getUTCFullYear(), qStartMonth - back * 3, 1));
    }
    case 'year':
      return new Date(Date.UTC(now.getUTCFullYear() - back, 0, 1));
    default:
      return null;
  }
}

// Parse a bucket key back to the UTC start date of its period so the
// zero-fill enumerator can step from bucket to bucket.
function bucketKeyStartDate(key, granularity) {
  switch ((granularity || 'month').toLowerCase()) {
    case 'month': {
      const [y, m] = key.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, 1));
    }
    case 'quarter': {
      const [y, q] = key.split('-Q').map(Number);
      return new Date(Date.UTC(y, (q - 1) * 3, 1));
    }
    case 'year':
      return new Date(Date.UTC(Number(key), 0, 1));
    default:
      // day / week keys are full YYYY-MM-DD dates.
      return new Date(`${key}T00:00:00.000Z`);
  }
}

function addGranularityPeriod(date, granularity) {
  const d = new Date(date.getTime());
  switch ((granularity || 'month').toLowerCase()) {
    case 'day': d.setUTCDate(d.getUTCDate() + 1); break;
    case 'week': d.setUTCDate(d.getUTCDate() + 7); break;
    case 'month': d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'quarter': d.setUTCMonth(d.getUTCMonth() + 3); break;
    case 'year': d.setUTCFullYear(d.getUTCFullYear() + 1); break;
    default: d.setUTCDate(d.getUTCDate() + 1); break;
  }
  return d;
}

/**
 * Turns a Map(bucketKey -> measure values) into sorted, chart-ready time
 * rows, honouring the time bucket's optional rolling window. Without a
 * window this reproduces the legacy behaviour exactly (every populated
 * bucket, sorted). With one, only buckets inside the window are kept and
 * every bucket between the window start and "now" appears — empty ones
 * zero-filled — so the axis shows a continuous run of the last X periods.
 * Shared by the generic, DD and booking aggregators. Exported for tests.
 */
export function finalizeTimeRows(buckets, timeBucket, aggregator, cumulative, now = new Date()) {
  const windowStart = resolveTimeWindowStart(timeBucket?.window, now);
  let sortedKeys;
  if (windowStart) {
    const endKey = bucketTimestamp(now, timeBucket.granularity);
    const startKey = bucketTimestamp(windowStart, timeBucket.granularity);
    sortedKeys = [];
    let cursor = bucketKeyStartDate(startKey, timeBucket.granularity);
    while (sortedKeys.length <= MAX_BUCKETS) {
      const key = bucketTimestamp(cursor, timeBucket.granularity);
      if (key > endKey) break;
      sortedKeys.push(key);
      cursor = addGranularityPeriod(cursor, timeBucket.granularity);
    }
  } else {
    sortedKeys = Array.from(buckets.keys()).sort();
  }
  if (sortedKeys.length > MAX_BUCKETS) {
    throw new Error(
      `Time bucketing produced ${sortedKeys.length} buckets (max ${MAX_BUCKETS}). ` +
      `Use a coarser granularity${windowStart ? ' or a smaller window' : ' or add a date filter'}.`,
    );
  }
  const timeRows = sortedKeys.map(key => ({
    key,
    value: aggregate(buckets.get(key) || [], aggregator),
  }));
  return cumulative ? applyCumulative(timeRows) : timeRows;
}

function bucketTimestamp(raw, granularity) {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  switch ((granularity || 'month').toLowerCase()) {
    case 'day':
      return d.toISOString().slice(0, 10);
    case 'week': {
      const day = d.getUTCDay();
      const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
      return monday.toISOString().slice(0, 10);
    }
    case 'month':
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    case 'quarter':
      return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    case 'year':
      return String(d.getUTCFullYear());
    default:
      return d.toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Due Diligence Submissions aggregator
//
// DD rows live in `form_submission_due_diligence` keyed by tenant_id, but the
// useful filter/group dimensions are spread across multiple tables and need
// canonicalisation per-form:
//   - workflow_status is stored as either a stage UUID or a stage label,
//     varying by form. The 7 canonical buckets (New / In Review / Verified /
//     DD Meet Attended / Held / Rejected / Incomplete, plus Approved when
//     present) come from the shared DD report helpers (canonicalizeKey +
//     buildStageMaps + mkMatchers), including Held disambiguation
//     (meeting-outcome vs decision-pending) so this widget stays consistent
//     with the DD reports page.
//   - form_id / submitted_at / organization_id are joined off form_submission.
//   - org_type is the tenant's `org_type` preference on `organization`
//     (a dropdown custom field), loaded only when the widget references it.
// All filtering/grouping then happens in JS on the flattened rows so we
// can reuse the existing matchFilter / aggregate / bucketTimestamp /
// normaliseKey helpers without surfacing DD quirks back into the generic
// engine.
const DD_STATUS_BUCKETS = [
  { label: 'New', isMatch: (m, _maps, s) => m.isNew(s) },
  { label: 'In Review', isMatch: (m, _maps, s) => m.isInReview(s) },
  { label: 'Verified', isMatch: (m, _maps, s) => m.isVerified(s) },
  { label: 'DD Meet Attended', isMatch: (m, _maps, s) => m.isDDMeetAttended(s) },
  { label: 'Approved', isMatch: (m, _maps, s) => m.isApproved(s) },
  { label: 'Rejected', isMatch: (m, _maps, s) => m.isRejected(s) },
  {
    label: 'Incomplete',
    // mkMatchers() doesn't expose an isIncomplete helper, so we
    // combine the canonical-key match (handles label strings like
    // "Incomplete") with the per-form stage-UUID set built by
    // buildStageMaps (handles stored stage ids).
    isMatch: (_m, maps, s) => canonicalizeKey(s) === CANONICAL.incomplete
      || (maps?.incomplete && maps.incomplete.has(String(s))),
  },
];

function canonicaliseDdStatus(rawStatus, formId, matchers, isHeldDecisionForForm, stageMaps) {
  if (rawStatus === null || rawStatus === undefined || rawStatus === '') return null;
  // Held is its own bucket regardless of meeting-outcome vs
  // decision-pending semantics — both flavours roll up under "Held"
  // for grouping. We still call isHeldDecisionForForm so the per-form
  // disambiguation is consulted (matches DD report behaviour) even
  // though the resulting label is identical.
  if (matchers.isHeld(rawStatus)) {
    // Reading the form's stage order keeps this in lock-step with the
    // DD reports page; future widgets could surface the distinction.
    isHeldDecisionForForm?.(formId);
    return 'Held';
  }
  for (const bucket of DD_STATUS_BUCKETS) {
    if (bucket.isMatch(matchers, stageMaps, rawStatus)) return bucket.label;
  }
  // Unknown / non-canonical status — pass through so admins can spot it.
  return String(rawStatus);
}

// Derive a row's "moved to stage X" timestamp: the FIRST time its history_log
// records a transition into `chosenStage` (a canonical DD status label). Stage
// matching reuses canonicaliseDdStatus so a stored stage UUID or label both
// match, consistent with the DD reports/transition counting. Returns an ISO
// string (so it feeds bucketTimestamp / matchFilter like a real date column)
// or null when the submission never entered that stage.
function ddStageEntryAt(row, chosenStage, ddCtx) {
  if (!chosenStage) return null;
  const { matchers, isHeldDecisionForForm, stageMaps } = ddCtx;
  const at = findFirstTransitionAt(row.history_log, (_canonical, entry) => {
    const label = canonicaliseDdStatus(
      getStatusFromHistory(entry, 'new'), row.form_id, matchers, isHeldDecisionForForm, stageMaps,
    );
    return label === chosenStage;
  });
  return at ? at.toISOString() : null;
}

function ddFieldUsed(config, fieldName) {
  if (!config) return false;
  const matchRef = (ref) => ref && ref.fieldKind === 'system' && ref.field === fieldName;
  if (matchRef(config.measure)) return true;
  if (config.groupBy?.kind === 'system' && config.groupBy.field === fieldName) return true;
  if (config.timeBucket?.fieldKind !== 'custom' && config.timeBucket?.field === fieldName) return true;
  return (config.filters || []).some(matchRef);
}

// Count DD stage transitions across the flattened submission rows.
// A transition is a single consecutive `status_changed` history event; each
// event is counted independently (a stage that is set, reverted, and re-set
// counts twice). System filters split in two: date-typed filters scope the
// transition by its OWN timestamp (so a transition is counted in a period
// based on when it happened, not when the submission was created); every
// other filter selects which submissions are eligible.
function computeDdTransitions(flat, config, source, transition, ddCtx) {
  const { matchers, isHeldDecisionForForm, stageMaps } = ddCtx;
  const mode = transition.mode === 'single' ? 'single' : 'breakdown';
  const fromStage = transition.fromStage || null;
  const toStage = transition.toStage || null;

  const dateFieldNames = new Set(
    (source.systemFields || []).filter(f => f.type === 'date').map(f => f.name),
  );
  const allFilters = (config.filters || []).filter(f => f.fieldKind === 'system' && f.field);
  const submissionFilters = allFilters.filter(f => !dateFieldNames.has(f.field));
  const dateFilters = allFilters.filter(f => dateFieldNames.has(f.field));

  const eligible = flat.filter(row =>
    submissionFilters.every(f => matchFilter(row[f.field], f, null, false)),
  );

  const inDateRange = ts => {
    if (dateFilters.length === 0) return true;
    if (!ts) return false;
    return dateFilters.every(f => matchFilter(ts, f, null, false));
  };

  const counts = new Map();
  let singleCount = 0;

  for (const sub of eligible) {
    const formId = sub.form_id;
    for (const entry of sortedHistory(sub.history_log)) {
      const prevLabel = canonicaliseDdStatus(
        getStatusFromHistory(entry, 'previous'), formId, matchers, isHeldDecisionForForm, stageMaps,
      );
      const newLabel = canonicaliseDdStatus(
        getStatusFromHistory(entry, 'new'), formId, matchers, isHeldDecisionForForm, stageMaps,
      );
      if (!prevLabel || !newLabel) continue;
      if (!inDateRange(entry.timestamp || null)) continue;

      if (mode === 'single') {
        if ((!fromStage || prevLabel === fromStage) && (!toStage || newLabel === toStage)) {
          singleCount += 1;
        }
      } else {
        const key = `${prevLabel} → ${newLabel}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }

  if (mode === 'single') {
    return {
      type: 'scalar',
      total: singleCount,
      value: singleCount,
      rows: [{ key: 'total', value: singleCount }],
    };
  }

  const rows = Array.from(counts.entries())
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value);
  if (rows.length > MAX_GROUPS) {
    throw new Error(
      `Stage transitions produced ${rows.length} pairs (max ${MAX_GROUPS}). Add filters to narrow the dataset.`,
    );
  }
  return {
    type: 'group',
    total: rows.reduce((a, r) => a + r.value, 0),
    categories: ['value'],
    rows,
  };
}

async function runDdWidgetConfig(config, tenantId, source, maxGroups = MAX_GROUPS) {
  const measure = normaliseMeasure(config.measure);
  // Stage-transition mode counts `status_changed` history events rather than
  // current-status rows, so group-by / time-bucket don't apply — neutralise
  // them here so the generic checks below stay happy.
  const transition = config.transition && config.transition.mode ? config.transition : null;
  const groupBy = transition ? null : (config.groupBy || null);
  const timeBucket = transition ? null : (config.timeBucket || null);

  // "Date moved to stage …" is a synthetic, history-derived date dimension.
  // Detect its use (as the time-bucket field or as a filter field) so we know
  // to fetch history_log and resolve which stage the entry timestamp tracks.
  const movedFilters = transition
    ? []
    : (config.filters || []).filter(f => f.fieldKind === 'system' && f.field === DD_MOVED_TO_STAGE_FIELD);
  const usesMovedToStage = !!(timeBucket && timeBucket.field === DD_MOVED_TO_STAGE_FIELD)
    || movedFilters.length > 0;
  // Single stage drives the derivation; prefer the time-bucket's stage, else
  // the first date-range filter's stage. (Both normally pick the same stage.)
  const movedStage = (timeBucket && timeBucket.field === DD_MOVED_TO_STAGE_FIELD ? timeBucket.stage : null)
    || movedFilters.map(f => f.stage).find(Boolean)
    || null;
  const needsHistory = !!transition || usesMovedToStage;
  if (usesMovedToStage && !movedStage) {
    throw new Error('Pick a stage for the "Date moved to stage" field.');
  }

  if (!measure) throw new Error('Measure is required');
  if (groupBy && timeBucket) throw new Error('Choose either group-by or time-bucket, not both');

  // Numeric aggregators are not meaningful over the current DD field
  // set (id / status / ids / dates / org_type) — reject so users get a
  // clear error instead of NaN/0.
  if (NUMERIC_AGGREGATORS.has(measure.aggregator)) {
    throw new Error(
      `${measure.aggregator} is not supported on Due Diligence Submissions — only count / count_distinct.`,
    );
  }
  if (measure.fieldKind === 'custom' || groupBy?.kind === 'custom' || timeBucket?.fieldKind === 'custom') {
    throw new Error('Due Diligence Submissions does not expose custom fields');
  }

  // Load DD configs first so we can build stage maps + restrict the
  // submissions set to forms that have a DD config (matches DD reports).
  const { data: ddConfigs, error: cfgErr } = await supabase
    .from('form_due_diligence_config')
    .select('form_id, workflow_stages')
    .eq('tenant_id', tenantId)
    .eq('is_active', true);
  if (cfgErr) throw new Error(`DD config query failed: ${cfgErr.message}`);
  const ddFormIds = new Set((ddConfigs || []).map(c => c.form_id));
  const { stageMaps, isHeldDecisionForForm } = buildStageMaps(ddConfigs || []);
  const matchers = mkMatchers(stageMaps);

  // Paginate the DD rows. We join form_submission to pull form_id /
  // submitted_at / organization_id in one round-trip. Filters by
  // form_id / organization_id can't be pushed down through the join
  // shape that PostgREST returns, so we apply them in JS post-fetch.
  let rawRows = [];
  for (let from = 0; from < MAX_TOTAL_ROWS; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE - 1, MAX_TOTAL_ROWS - 1);
    const { data: page, error } = await supabase
      .from('form_submission_due_diligence')
      .select(`
        id,
        workflow_status,
        created_at,${needsHistory ? '\n        history_log,' : ''}
        form_submission:form_submission_id(id, form_id, organization_id, created_date)
      `)
      .eq('tenant_id', tenantId)
      .is('archived_at', null)
      // Stable ordering is required for .range() pagination.
      .order('id', { ascending: true })
      .range(from, to);
    if (error) throw new Error(`DD source query failed: ${error.message}`);
    if (!page || page.length === 0) break;
    rawRows = rawRows.concat(page);
    if (page.length < PAGE_SIZE) break;
    if (rawRows.length >= MAX_TOTAL_ROWS) {
      throw new Error(
        `Widget would scan more than ${MAX_TOTAL_ROWS} rows. Add filters to narrow the dataset.`,
      );
    }
  }

  // Flatten + canonicalise.
  const flat = [];
  for (const r of rawRows) {
    const fs = r.form_submission || null;
    const formId = fs?.form_id || null;
    if (!formId || !ddFormIds.has(formId)) continue;
    flat.push({
      id: r.id,
      workflow_status: canonicaliseDdStatus(r.workflow_status, formId, matchers, isHeldDecisionForForm, stageMaps),
      organization_id: fs?.organization_id || null,
      form_id: formId,
      submitted_at: fs?.created_date || null,
      created_at: r.created_at,
      org_type: null,
      history_log: needsHistory ? (r.history_log || null) : null,
    });
  }

  // Derive the synthetic "moved to stage" timestamp per row before any
  // filtering / bucketing, so it behaves like a real date column downstream.
  if (usesMovedToStage) {
    const ddCtx = { matchers, isHeldDecisionForForm, stageMaps };
    flat.forEach(r => { r[DD_MOVED_TO_STAGE_FIELD] = ddStageEntryAt(r, movedStage, ddCtx); });
  }

  // Hydrate org_type only if the widget actually references it.
  if (ddFieldUsed(config, 'org_type')) {
    const orgIds = Array.from(new Set(flat.map(r => r.organization_id).filter(Boolean)));
    if (orgIds.length > 0) {
      const { data: orgTypeField } = await supabase
        .from('preference_field')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('entity_scope', 'organization')
        .eq('name', 'org_type')
        .maybeSingle();
      if (orgTypeField?.id) {
        const orgTypeMap = new Map();
        const chunk = 500;
        for (let i = 0; i < orgIds.length; i += chunk) {
          const slice = orgIds.slice(i, i + chunk);
          const { data: prefs, error: prefErr } = await supabase
            .from('organization_preference_value')
            .select('organization_id, value')
            .in('organization_id', slice)
            .eq('field_id', orgTypeField.id);
          if (prefErr) {
            // Fail loudly: silently-missing org_type values would mis-bucket
            // rows as "Unspecified" (or drop them from org_type filters).
            throw new Error(`org_type preference query failed: ${prefErr.message}`);
          }
          (prefs || []).forEach(p => {
            orgTypeMap.set(p.organization_id, extractPrimitive(parsePreferenceValue(p.value)));
          });
        }
        flat.forEach(r => { r.org_type = orgTypeMap.get(r.organization_id) ?? null; });
      }
    }
  }

  // Stage-transition mode: count `status_changed` history events instead of
  // aggregating current-status rows. Diverges from the generic measure path
  // here because the unit of counting is a history event, not a submission.
  if (transition) {
    return computeDdTransitions(flat, config, source, transition, {
      matchers, isHeldDecisionForForm, stageMaps,
    });
  }

  // Apply all filters in JS (system filters become row-level matchers
  // against the flat row shape; no LMIC support on DD).
  const filters = (config.filters || []).filter(f => f.fieldKind === 'system' && f.field);
  const workingRows = flat.filter(row => filters.every(f => matchFilter(row[f.field], f, null, false)));

  const measureValueOf = row => {
    if (!measure.field) return null;
    if (measure.fieldKind === 'system') return row[measure.field];
    return null;
  };
  const pushMeasureValues = (target, row) => target.push(measureValueOf(row));

  const groupKeyOf = groupBy && groupBy.field
    ? row => normaliseKey(row[groupBy.field])
    : null;
  const timeKeyOf = timeBucket && timeBucket.field
    ? row => bucketTimestamp(row[timeBucket.field], timeBucket.granularity)
    : null;

  if (!groupBy && !timeBucket) {
    const values = [];
    for (const row of workingRows) pushMeasureValues(values, row);
    const value = aggregate(values, measure.aggregator);
    return {
      type: 'scalar',
      total: workingRows.length,
      value,
      rows: [{ key: 'total', value }],
    };
  }

  if (groupBy) {
    const buckets = new Map();
    workingRows.forEach(row => {
      const key = groupKeyOf(row);
      if (!buckets.has(key)) buckets.set(key, []);
      pushMeasureValues(buckets.get(key), row);
    });
    const grouped = Array.from(buckets.entries())
      .map(([key, values]) => ({ key, value: aggregate(values, measure.aggregator) }))
      .sort((a, b) => b.value - a.value);
    if (grouped.length > maxGroups) {
      throw new Error(
        `Group-by produced ${grouped.length} groups (max ${maxGroups}). ` +
        `Add a filter or pick a less granular field.`,
      );
    }
    return {
      type: 'group',
      total: workingRows.length,
      categories: ['value'],
      rows: grouped,
    };
  }

  const buckets = new Map();
  workingRows.forEach(row => {
    const key = timeKeyOf(row);
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    pushMeasureValues(buckets.get(key), row);
  });
  return {
    type: 'time',
    total: workingRows.length,
    categories: ['value'],
    rows: finalizeTimeRows(buckets, timeBucket, measure.aggregator, config.cumulative),
    granularity: timeBucket.granularity,
  };
}

const BOOKING_PUSHDOWN_FIELDS = new Set(['created_at', 'status']);
/**
 * Paginate every submission of a single form for a tenant past PostgREST's
 * 1000-row page cap. `dateFilters` (system filters on created_date) are
 * applied at the query level when supplied.
 */
async function fetchFormSubmissions(formId, tenantId, dateFilters = []) {
  const rows = [];
  for (let from = 0; from < MAX_TOTAL_ROWS; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE - 1, MAX_TOTAL_ROWS - 1);
    let query = supabase
      .from('form_submission')
      .select('id, organization_id, submitted_by_email, created_date')
      .eq('tenant_id', tenantId)
      .eq('form_id', formId)
      // Stable ordering is required for .range() pagination — without it
      // PostgREST may skip or repeat rows across pages.
      .order('id', { ascending: true });
    query = applySystemFilters(query, dateFilters, null);
    const { data: page, error } = await query.range(from, to);
    if (error) {
      throw new Error(`Failed to fetch form submissions: ${error.message}`);
    }
    rows.push(...(page || []));
    if (!page || page.length < PAGE_SIZE) break;
    // A full page that fills our scan budget means more rows remain — refuse
    // rather than silently truncate (matches the generic aggregator's guard).
    if (rows.length >= MAX_TOTAL_ROWS) {
      throw new Error(
        `Widget would scan more than ${MAX_TOTAL_ROWS} rows. ` +
        `Add filters to narrow the dataset.`,
      );
    }
  }
  return rows;
}

/**
 * Form conversion: count distinct entities (organisations or members by
 * lowercased submitter email) that submitted BOTH the source form and the
 * target form. Date filters (system created_date filters) scope the TARGET
 * form's submissions only — a conversion counts when the target submission
 * falls inside the range, regardless of when the source one happened.
 */
async function runConversionWidgetConfig(config, tenantId, source) {
  const conv = config.conversion || {};
  const { sourceFormId, matchBy } = conv;
  // Multi-target: `targetFormIds` is a list; legacy configs carry a single
  // `targetFormId`. An entity converts when it submitted ANY target form.
  const targetFormIds = [
    ...new Set(
      (Array.isArray(conv.targetFormIds) && conv.targetFormIds.length > 0
        ? conv.targetFormIds
        : [conv.targetFormId]
      ).filter(Boolean),
    ),
  ];
  if (!sourceFormId || targetFormIds.length === 0) {
    throw new Error('Choose a source form and at least one target form');
  }
  if (targetFormIds.includes(sourceFormId)) {
    throw new Error('Source and target forms must be different');
  }
  if (targetFormIds.length > 20) {
    throw new Error('Choose at most 20 target forms');
  }
  if (matchBy !== 'organization' && matchBy !== 'member') {
    throw new Error('Match by must be organisation or member');
  }

  // All forms must belong to this tenant — otherwise a crafted config
  // could count another tenant's submissions.
  const allFormIds = [sourceFormId, ...targetFormIds];
  const { data: forms, error: formErr } = await supabase
    .from('form')
    .select('id')
    .eq('tenant_id', tenantId)
    .in('id', allFormIds);
  if (formErr) {
    throw new Error(`Failed to verify forms: ${formErr.message}`);
  }
  const foundIds = new Set((forms || []).map(f => f.id));
  if (!allFormIds.every(id => foundIds.has(id))) {
    throw new Error('One or more selected forms no longer exist');
  }

  const timestampField = source.timestampField || 'created_date';
  const dateFilters = (config.filters || []).filter(
    f => f.fieldKind === 'system' && f.field === timestampField,
  );

  const [sourceRows, ...targetRowsPerForm] = await Promise.all([
    fetchFormSubmissions(sourceFormId, tenantId),
    ...targetFormIds.map(id => fetchFormSubmissions(id, tenantId, dateFilters)),
  ]);
  // Union of all target forms' submissions.
  const targetRows = targetRowsPerForm.flat();

  // Rows without a usable match key (no organisation / blank email) can
  // never convert, so they're skipped when building the key sets — but
  // they still count toward the raw submission totals shown on the card.
  const keyOf = row => {
    if (matchBy === 'organization') return row.organization_id || null;
    const email = typeof row.submitted_by_email === 'string'
      ? row.submitted_by_email.trim().toLowerCase()
      : '';
    return email || null;
  };
  const sourceKeys = new Set();
  for (const row of sourceRows) {
    const key = keyOf(row);
    if (key) sourceKeys.add(key);
  }
  const targetKeys = new Set();
  for (const row of targetRows) {
    const key = keyOf(row);
    if (key) targetKeys.add(key);
  }

  let convertedCount = 0;
  for (const key of sourceKeys) {
    if (targetKeys.has(key)) convertedCount += 1;
  }
  const sourceEntityCount = sourceKeys.size;
  const conversionRate = sourceEntityCount > 0
    ? (convertedCount / sourceEntityCount) * 100
    : null;

  return {
    type: 'conversion',
    value: convertedCount,
    convertedCount,
    conversionRate,
    matchBy,
    sourceSubmissionCount: sourceRows.length,
    targetSubmissionCount: targetRows.length,
    sourceEntityCount,
    targetEntityCount: targetKeys.size,
    notConvertedCount: sourceEntityCount - convertedCount,
    total: convertedCount,
    categories: ['value'],
    rows: [{ key: 'Converted', value: convertedCount }],
  };
}

async function loadBookingEventNames(rows, tenantId) {
  const byKind = { simple: new Set(), complex: new Set() };
  for (const row of rows) {
    if (row.event_id) byKind[row.event_kind]?.add(String(row.event_id));
  }
  const nameByKey = new Map();
  const CHUNK = 200;
  for (const [kind, table] of [['simple', 'event'], ['complex', 'complex_event']]) {
    const ids = Array.from(byKind[kind]);
    for (let i = 0; i < ids.length; i += CHUNK) {
      let q = supabase
        .from(table)
        .select('id, title')
        .in('id', ids.slice(i, i + CHUNK));
      q = tenantFilter(q, tenantId);
      const { data, error } = await q;
      if (error) {
        console.error(`[Dashboard Aggregation] Failed to resolve ${table} titles:`, error.message);
        continue;
      }
      for (const row of data || []) {
        nameByKey.set(`${kind}:${row.id}`, row.title ?? null);
      }
    }
  }
  return nameByKey;
}

const SIMPLE_BOOKING_COLUMNS =
  'id, event_id, member_id, organization_id, attendee_email, ticket_class_name, status, created_at, is_guest_booking';

/**
 * Paginate one booking table for a tenant, applying pushdown-able system
 * filters (created_at / status) at the query level. `budget` caps the rows
 * fetched across BOTH tables so a huge tenant fails loudly instead of
 * silently truncating.
 */
async function fetchBookingRows(table, columns, tenantId, pushdownFilters, budget) {
  const rows = [];
  for (let from = 0; from < budget; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE - 1, budget - 1);
    let q = supabase
      .from(table)
      .select(columns)
      .eq('tenant_id', tenantId)
      // Stable ordering is required for .range() pagination.
      .order('id', { ascending: true });
    q = applySystemFilters(q, pushdownFilters, null);
    const { data: page, error } = await q.range(from, to);
    if (error) throw new Error(`Booking source query failed: ${error.message}`);
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    if (rows.length >= budget) {
      throw new Error(
        `Widget would scan more than ${MAX_TOTAL_ROWS} rows. ` +
        `Add filters to narrow the dataset.`,
      );
    }
  }
  return rows;
}

/**
 * Resolve organisation-level (orgField) filters into the Set of matching
 * organisation ids (as strings). Loads the tenant's full organisation list
 * (paginated — PostgREST caps responses at 1000 rows), hydrates the
 * referenced organisation preference values, and applies the same
 * matchFilter semantics as the generic engine — including any-element
 * matching for list-typed fields and LMIC expansion for country fields.
 * Organisations with NO stored value only match is_null / neq-style
 * predicates, exactly like the organisation-source widgets.
 */
async function resolveBookingOrgFilterIds(orgFilters, tenantId) {
  const orgIds = await loadAllTenantOrgIds(tenantId);
  const fieldIds = new Set(orgFilters.map(f => f.fieldId));
  const prefMap = await loadPreferenceValues({
    table: 'organization_preference_value',
    fkColumn: 'organization_id',
    ids: orgIds,
    fieldIds: Array.from(fieldIds),
  });
  const { listFieldIds } = await resolveListFieldIds(
    getSourceDef('organization'), tenantId, fieldIds,
  );
  const lmicCodes = orgFilters.some(f => f.operator === 'lmic' || f.operator === 'not_lmic')
    ? await loadTenantLmicCodes(tenantId)
    : null;
  const allowed = new Set();
  for (const id of orgIds) {
    if (orgMatchesOrgFilters(prefMap.get(id) || {}, orgFilters, lmicCodes, listFieldIds)) {
      allowed.add(String(id));
    }
  }
  return allowed;
}

/**
 * Pure predicate: does one organisation's hydrated preference map satisfy
 * every organisation-level filter? Same matchFilter semantics as the
 * organisation-source widgets (any-element for list fields, LMIC
 * expansion, is_null on missing values). Exported for tests.
 */
export function orgMatchesOrgFilters(prefs, orgFilters, lmicCodes, listFieldIds) {
  return orgFilters.every(f =>
    matchFilter(prefs[f.fieldId], f, lmicCodes, listFieldIds?.has?.(f.fieldId) ?? false),
  );
}

async function loadAllTenantOrgIds(tenantId) {
  const ids = [];
  for (let from = 0; from < MAX_TOTAL_ROWS; from += PAGE_SIZE) {
    let q = supabase
      .from('organization')
      .select('id')
      .order('id', { ascending: true });
    q = tenantFilter(q, tenantId);
    const { data: page, error } = await q.range(from, Math.min(from + PAGE_SIZE - 1, MAX_TOTAL_ROWS - 1));
    if (error) throw new Error(`Organisation list query failed: ${error.message}`);
    if (!page || page.length === 0) break;
    ids.push(...page.map(r => r.id));
    if (page.length < PAGE_SIZE) break;
    if (ids.length >= MAX_TOTAL_ROWS) {
      throw new Error(
        `Widget would scan more than ${MAX_TOTAL_ROWS} rows. Add filters to narrow the dataset.`,
      );
    }
  }
  return ids;
}

async function loadMemberDisplayNames(rawIds, tenantId) {
  const ids = Array.from(
    new Set(rawIds.filter(v => v !== null && v !== undefined && v !== '').map(String)),
  );
  const nameById = new Map();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    let q = supabase
      .from('member')
      .select('id, first_name, last_name, email')
      .in('id', ids.slice(i, i + CHUNK));
    q = tenantFilter(q, tenantId);
    const { data, error } = await q;
    if (error) {
      console.error('[Dashboard Aggregation] Failed to resolve member names:', error.message);
      return nameById;
    }
    for (const row of data || []) {
      const full = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
      nameById.set(String(row.id), full || row.email || null);
    }
  }
  return nameById;
}

/**
 * Normalise a raw booking row from either table into the unified shape the
 * booking aggregator works on. `kind` is 'simple' or 'complex'. Ids are
 * prefixed with the kind so rows from the two tables can never collide.
 * Guest flag follows the registration-report semantics: simple bookings
 * carry an explicit is_guest_booking column; complex bookings have no such
 * column and a booking without a linked member is a guest. Note this is
 * independent of organisation linkage — a member booking can lack an
 * organisation without being a guest booking.
 * Exported for tests.
 */
export function normaliseBookingRow(row, kind) {
  return {
    id: `${kind}:${row.id}`,
    event_kind: kind,
    event_id: row.event_id || null,
    organization_id: row.organization_id || null,
    member_id: row.member_id || null,
    attendee_email: row.attendee_email || null,
    ticket_class_name: row.ticket_class_name || null,
    status: row.status || null,
    created_at: row.created_at || null,
    is_guest_booking: kind === 'simple'
      ? row.is_guest_booking === true
      : !row.member_id,
  };
}

/**
 * Measure value for one normalised booking row. When no field is selected
 * (the builder allows this for count / count_distinct) the normalised
 * booking id is used — it is unique across both tables, so plain count is
 * unchanged and count_distinct degrades to "distinct bookings" instead of
 * excluding every (null) value and returning 0. Exported for tests.
 */
export function bookingMeasureValue(row, measure) {
  return measure?.field ? row[measure.field] : row.id;
}

async function runBookingWidgetConfig(config, tenantId, source, maxGroups = MAX_GROUPS, options = {}) {
  const measure = normaliseMeasure(config.measure);
  const participation = config.participation === true;
  // Participation mode has its own fixed output shape (Booked / Not
  // booked); group-by and time-bucket don't apply.
  const groupBy = participation ? null : (config.groupBy || null);
  const timeBucket = participation ? null : (config.timeBucket || null);

  if (!measure) throw new Error('Measure is required');
  if (groupBy && timeBucket) throw new Error('Choose either group-by or time-bucket, not both');
  // No numeric fields are exposed on this source, and there is no
  // preference store — reject up front with clear messages.
  if (NUMERIC_AGGREGATORS.has(measure.aggregator)) {
    throw new Error(
      `${measure.aggregator} is not supported on Event Bookings — only count / count_distinct.`,
    );
  }
  // Organisation-level filters: custom fields on the booking's linked
  // ORGANISATION (application status, org type, ...), marked orgField=true
  // by the builder. They're resolved against the organisation universe
  // below, not the booking rows.
  const orgFilters = (config.filters || []).filter(f => f.orgField === true);
  if (orgFilters.some(f => f.fieldKind !== 'custom' || !f.fieldId)) {
    throw new Error('Organisation filters on Event Bookings must reference an organisation custom field');
  }
  if (measure.fieldKind === 'custom' || groupBy?.kind === 'custom' || timeBucket?.fieldKind === 'custom'
    || (config.filters || []).some(f => f.fieldKind === 'custom' && f.orgField !== true)) {
    throw new Error('Event Bookings does not expose custom fields');
  }

  const systemFilters = (config.filters || []).filter(
    f => f.fieldKind === 'system' && f.field && f.orgField !== true,
  );
  const pushdownFilters = systemFilters.filter(f => BOOKING_PUSHDOWN_FIELDS.has(f.field));
  // event_kind filters let us skip fetching a whole table when the widget
  // only looks at one kind.
  const kindWanted = kind => systemFilters
    .filter(f => f.field === 'event_kind')
    .every(f => matchFilter(kind, f, null, false));

  const [simpleRaw, complexRaw] = await Promise.all([
    kindWanted('simple')
      ? fetchBookingRows(source.table, SIMPLE_BOOKING_COLUMNS, tenantId, pushdownFilters, MAX_TOTAL_ROWS)
      : Promise.resolve([]),
    kindWanted('complex')
      ? fetchBookingRows(source.complexTable, COMPLEX_BOOKING_COLUMNS, tenantId, pushdownFilters, MAX_TOTAL_ROWS)
      : Promise.resolve([]),
  ]);
  if (simpleRaw.length + complexRaw.length > MAX_TOTAL_ROWS) {
    throw new Error(
      `Widget would scan more than ${MAX_TOTAL_ROWS} rows. Add filters to narrow the dataset.`,
    );
  }

  const normalised = [
    ...simpleRaw.map(r => normaliseBookingRow(r, 'simple')),
    ...complexRaw.map(r => normaliseBookingRow(r, 'complex')),
  ];

  // Apply ALL system filters in JS on the normalised shape (pushdown
  // filters re-apply harmlessly — identical semantics via matchFilter).
  let workingRows = normalised.filter(row =>
    systemFilters.every(f => matchFilter(row[f.field], f, null, false)),
  );

  // Resolve organisation-level filters into the set of matching org ids.
  // null = no org filters (everything allowed, universe unrestricted).
  const allowedOrgIds = orgFilters.length > 0
    ? await resolveBookingOrgFilterIds(orgFilters, tenantId)
    : null;
  if (allowedOrgIds && !participation) {
    // A filter on the organisation implies "the booking's organisation
    // matches", so bookings with NO linked organisation (guest bookings,
    // org-less member bookings) are excluded along with non-matching orgs.
    workingRows = workingRows.filter(
      row => row.organization_id && allowedOrgIds.has(String(row.organization_id)),
    );
  }

  // --- Organisation participation split -----------------------------------
  if (participation) {
    // Org filters restrict the participation UNIVERSE itself: the split is
    // computed over matching organisations only, so "Not booked" never
    // counts organisations the filter excludes. Bookings by excluded orgs
    // are ignored by the split arithmetic (their org isn't in the set).
    const allOrgIds = allowedOrgIds
      ? Array.from(allowedOrgIds)
      : await loadAllTenantOrgIds(tenantId);
    const split = computeParticipationSplit(workingRows, allOrgIds);
    const withIds = (row, ids) => (options.collectRowIds ? { ...row, rowIds: ids } : row);
    return {
      type: 'group',
      total: split.totalOrganisations,
      categories: ['value'],
      participation: {
        totalOrganisations: split.totalOrganisations,
        bookedCount: split.bookedOrgIds.length,
        notBookedCount: split.notBookedOrgIds.length,
        // Bookings excluded from the split because they have no linked
        // organisation (guest bookings and org-less member bookings).
        noOrganisationCount: split.noOrganisationCount,
      },
      rows: [
        withIds({ key: 'Booked', value: split.bookedOrgIds.length }, split.bookedOrgIds),
        withIds({ key: 'Not booked', value: split.notBookedOrgIds.length }, split.notBookedOrgIds),
      ],
    };
  }

  // --- Reference-name resolution for group-by labels ----------------------
  let groupKeyOf = null;
  if (groupBy && groupBy.field) {
    if (groupBy.field === 'event_id') {
      const titleByKey = await loadBookingEventNames(workingRows, tenantId);
      groupKeyOf = row => {
        if (!row.event_id) return 'Unspecified';
        const title = titleByKey.get(`${row.event_kind}:${row.event_id}`);
        return title || 'Unknown';
      };
    } else if (groupBy.field === 'organization_id') {
      const nameById = await loadReferenceNames(
        'organization', workingRows.map(r => r.organization_id), tenantId,
      );
      groupKeyOf = row => referenceGroupKey(row.organization_id, nameById);
    } else if (groupBy.field === 'member_id') {
      const nameById = await loadMemberDisplayNames(workingRows.map(r => r.member_id), tenantId);
      groupKeyOf = row => referenceGroupKey(row.member_id, nameById);
    } else {
      groupKeyOf = row => normaliseKey(row[groupBy.field]);
    }
  }

  // No field selected: fall back to the (kind-prefixed, hence unique)
  // booking id so count_distinct without a field means "distinct bookings"
  // rather than silently counting nothing.
  const measureValueOf = row => bookingMeasureValue(row, measure);
  const pushMeasureValues = (target, row) => target.push(measureValueOf(row));

  if (!groupBy && !timeBucket) {
    const values = [];
    for (const row of workingRows) pushMeasureValues(values, row);
    const value = aggregate(values, measure.aggregator);
    return {
      type: 'scalar',
      total: workingRows.length,
      value,
      rows: [{ key: 'total', value }],
    };
  }

  if (groupBy) {
    const buckets = new Map();
    // Drill-down: bookings have no CRM list page, so click-through opens
    // the ORGANISATIONS behind a bucket — collect distinct non-guest org
    // ids per bucket (guest bookings contribute to counts but have no
    // organisation to open).
    const bucketOrgIds = options.collectRowIds ? new Map() : null;
    workingRows.forEach(row => {
      const key = groupKeyOf(row);
      if (!buckets.has(key)) buckets.set(key, []);
      pushMeasureValues(buckets.get(key), row);
      if (bucketOrgIds && row.organization_id) {
        if (!bucketOrgIds.has(key)) bucketOrgIds.set(key, new Set());
        bucketOrgIds.get(key).add(row.organization_id);
      }
    });
    const grouped = Array.from(buckets.entries())
      .map(([key, values]) => ({
        key,
        value: aggregate(values, measure.aggregator),
        ...(bucketOrgIds
          ? { rowIds: Array.from(bucketOrgIds.get(key) || []) }
          : {}),
      }))
      .sort((a, b) => b.value - a.value);
    if (grouped.length > maxGroups) {
      throw new Error(
        `Group-by produced ${grouped.length} groups (max ${maxGroups}). ` +
        `Add a filter or pick a less granular field.`,
      );
    }
    return {
      type: 'group',
      total: workingRows.length,
      categories: ['value'],
      rows: grouped,
    };
  }

  // Time-bucket aggregation (created_at is the only date field).
  const buckets = new Map();
  workingRows.forEach(row => {
    const key = bucketTimestamp(row[timeBucket.field], timeBucket.granularity);
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    pushMeasureValues(buckets.get(key), row);
  });
  return {
    type: 'time',
    total: workingRows.length,
    categories: ['value'],
    rows: finalizeTimeRows(buckets, timeBucket, measure.aggregator, config.cumulative),
    granularity: timeBucket.granularity,
  };
}

const COMPLEX_BOOKING_COLUMNS =
  'id, event_id, member_id, organization_id, attendee_email, ticket_class_name, status, created_at';

/**
 * Organisation-participation arithmetic: dedupe the (already filtered)
 * booking rows to distinct organisations and split the tenant's full
 * organisation list into booked vs not booked. Any booking WITHOUT a
 * linked organisation — guest bookings, but also member bookings whose
 * member has no organisation — can't join either bucket; they're counted
 * separately as noOrganisationCount so the card can label the exclusion.
 * Bookings whose organisation is not in the tenant list (deleted org) are
 * ignored. Exported for tests.
 */
export function computeParticipationSplit(bookingRows, allOrgIds) {
  const orgSet = new Set((allOrgIds || []).map(String));
  const booked = new Set();
  let noOrganisationCount = 0;
  for (const row of bookingRows) {
    if (!row.organization_id) {
      noOrganisationCount += 1;
      continue;
    }
    const key = String(row.organization_id);
    if (orgSet.has(key)) booked.add(key);
  }
  const notBookedOrgIds = [];
  for (const id of orgSet) {
    if (!booked.has(id)) notBookedOrgIds.push(id);
  }
  return {
    bookedOrgIds: Array.from(booked),
    notBookedOrgIds,
    noOrganisationCount,
    totalOrganisations: orgSet.size,
  };
}
