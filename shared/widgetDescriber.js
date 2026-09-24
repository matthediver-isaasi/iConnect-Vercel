// Deterministic, template-based plain-language description of a dashboard
// widget config. Used to pre-fill the widget "helper text" (the ⓘ popover on
// the widget card) for existing widgets (backfill script) and via the
// "Suggest text" button in the widget builder. Pure + side-effect free so it
// can run in the browser, in Vercel functions and in node scripts.
//
// Inputs:
//   config      — the widget's stored config JSONB
//   options:
//     widgetType  — 'stat' | 'bar' | 'pie' | 'donut' | 'line' | 'list'
//     sourceLabel — human label of the data source (e.g. "Organisations")
//     fieldLabel  — (ref) => string | null. Resolves a field reference
//                   ({ field, fieldKind, fieldId }) to a human label.
//                   Fall back to the raw field name when it returns null.

const AGG_VERBS = {
  sum: 'Adds up',
  avg: 'Averages',
  min: 'Shows the lowest',
  max: 'Shows the highest',
};

const GRANULARITY_LABEL = {
  day: 'day',
  week: 'week',
  month: 'month',
  quarter: 'quarter',
  year: 'year',
};

const OPERATOR_PHRASES = {
  eq: 'is',
  neq: 'is not',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  in: 'is one of',
  is_null: 'is empty',
  is_not_null: 'is not empty',
};

function humaniseFieldName(name) {
  if (!name) return null;
  return String(name)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveLabel(ref, fieldLabel) {
  if (!ref) return null;
  const viaLookup = typeof fieldLabel === 'function' ? fieldLabel(ref) : null;
  if (viaLookup) return viaLookup;
  return humaniseFieldName(ref.field) || (ref.fieldId ? 'a custom field' : null);
}

function formatValue(value, mapOne = v => v) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(v => `"${mapOne(v)}"`).join(', ');
  return `"${mapOne(value)}"`;
}

// Lowercase a label for mid-sentence use, but keep acronyms (HQ, ESO,
// LMIC…) intact: a word stays as-is when it's 2+ chars of all caps.
function lowerFirst(s) {
  if (!s) return s;
  return String(s)
    .split(' ')
    .map(word =>
      word.length >= 2 && word === word.toUpperCase() && /[A-Z]/.test(word)
        ? word
        : word.toLowerCase(),
    )
    .join(' ');
}

function isCountryLabel(label) {
  const l = (label || '').toLowerCase();
  return l.includes('country') || l.includes('countries');
}

// Describe a single filter as an "Only includes …" style clause.
function describeFilter(filter, fieldLabel, valueLabel) {
  const label = resolveLabel(filter, fieldLabel) || 'a field';
  switch (filter.operator) {
    case 'lmic':
      return `${label} is on this site's LMIC (low- and middle-income countries) list`;
    case 'not_lmic':
      return `${label} is NOT on this site's LMIC list (values that can't be matched to a known country are left out of both LMIC and non-LMIC)`;
    case 'is_null':
      return `${label} is empty`;
    case 'is_not_null':
      return `${label} is not empty`;
    default: {
      const phrase = OPERATOR_PHRASES[filter.operator] || filter.operator;
      // Optional value resolver turns opaque stored values (e.g. a form's
      // UUID) into their human names.
      const mapOne = v =>
        (typeof valueLabel === 'function' && valueLabel(filter, v)) || v;
      const value = formatValue(filter.value, mapOne);
      return value ? `${label} ${phrase} ${value}` : `${label} ${phrase}`;
    }
  }
}

function membershipPeriodLabel(value) {
  const month = Number(value?.startMonth);
  const year = Number(value?.startYear);
  if (!Number.isInteger(month) || month < 1 || month > 12
      || !Number.isInteger(year)) return 'the selected annual period';
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year + 1, month - 1, 0));
  const fmt = date => date.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  return `${fmt(start)} to ${fmt(end)}`;
}

export function describeWidgetConfig(config, options = {}) {
  if (!config) return '';
  const { widgetType = 'stat', sourceLabel = 'records', fieldLabel, valueLabel } = options;
  const sentences = [];
  const sourcePlural = lowerFirst(sourceLabel);

  // --- What is measured -------------------------------------------------
  if (config.source === 'organisation_membership') {
    const membershipValue = config.membershipValue || {};
    sentences.push(
      `Shows recorded organisation membership value for ${membershipPeriodLabel(membershipValue)}, including a saved membership when its structure effective date falls within that exact 12-month period.`,
    );
    sentences.push(
      'The headline is net of VAT; unpaid membership records are included. It is not cash received: payments, refunds and credits are not reconciled. Records without reliable valuation evidence are excluded and shown as warnings; an incomplete zero is unavailable, not a confident zero.',
    );
    if (membershipValue.currency) {
      sentences.push(`Only ${String(membershipValue.currency).toUpperCase()} records are included; currencies are never converted or added together.`);
    }
    if (Array.isArray(membershipValue.configIds) && membershipValue.configIds.length > 0) {
      sentences.push('Only the selected membership structures are included.');
    }
    if (Array.isArray(membershipValue.bandIds) && membershipValue.bandIds.length > 0) {
      sentences.push('Only the selected membership bands are included.');
    }
  } else if (config.source === 'member_group') {
    const measure = config.measure?.field || 'groups';
    const descriptions = {
      groups: 'Counts distinct member groups, including empty groups.',
      current_members: 'Counts distinct current members with unexpired group memberships. Empty groups show zero. Members in multiple groups count once in the overall result; group counts must not be added to obtain a tenant-wide headcount.',
      joins: 'Counts membership joins, not current headcounts. A rejoin after a gap counts again; overlapping assignments and role changes do not create extra joins. Baseline memberships are not new joins.',
      period_end_members: 'Counts distinct members present immediately before each UTC period boundary, not joins or cumulative joins. The incomplete current period shows membership now and is provisional. Members in multiple groups count once overall; group counts are not additive.',
    };
    sentences.push(descriptions[measure] || 'Shows member group reporting.');
    sentences.push('Guest assignments are excluded. Hidden and login-disabled members remain eligible; public-directory eligibility is not applied. Inactive groups are included unless filtered. Deleted members are excluded from current counts; recorded historical membership evidence is retained.');
    if (measure === 'joins' || measure === 'period_end_members') {
      sentences.push('Authoritative history starts at the reporting baseline; older periods are unavailable, not zero. Historical filters use CURRENT member attributes. Deleted members remain in unfiltered historical headcounts but have no current attributes to match member filters. Group names and active state use the latest recorded values, not their past values.');
    }
    if (config.seriesBy?.field === 'group_id') sentences.push('Each named group has its own series.');
  } else if (config.source === 'form_conversion' && config.conversion) {
    const matchBy =
      config.conversion.matchBy === 'member' ? 'person' : 'organisation';
    sentences.push(
      `Shows how many ${matchBy}s that submitted the source form went on to submit a target form (a conversion), with the conversion rate.`,
    );
  } else if (config.transition?.mode) {
    if (config.transition.mode === 'single') {
      const from = config.transition.fromStage || 'any stage';
      const to = config.transition.toStage || 'any stage';
      sentences.push(
        `Counts how many due diligence submissions moved from "${from}" to "${to}".`,
      );
    } else {
      sentences.push(
        'Counts due diligence stage changes, with one bar for each "from → to" move.',
      );
    }
  } else {
    const agg = config.measure?.aggregator || 'count';
    if (agg === 'count') {
      sentences.push(`Counts ${sourcePlural}.`);
    } else if (agg === 'count_distinct') {
      const label = resolveLabel(config.measure, fieldLabel) || 'the chosen field';
      sentences.push(
        `Counts how many different values of ${label} appear across ${sourcePlural}.`,
      );
    } else {
      const verb = AGG_VERBS[agg] || 'Summarises';
      let label = resolveLabel(config.measure, fieldLabel) || 'the chosen field';
      const extras = (config.measure?.additionalFields || [])
        .map(f => resolveLabel(f, fieldLabel))
        .filter(Boolean);
      if (extras.length > 0) {
        label = `${label} plus ${extras.join(' plus ')}`;
      }
      sentences.push(`${verb} ${label} across ${sourcePlural}.`);
    }
  }

  // --- Group-by ----------------------------------------------------------
  const groupBy = config.groupBy || null;
  let groupLabel = null;
  if (groupBy) {
    groupLabel = resolveLabel({ ...groupBy, fieldKind: groupBy.kind }, fieldLabel);
    if (!groupLabel) groupLabel = humaniseFieldName(groupBy.field) || 'group';
    if ((groupBy.field || '').toLowerCase() === 'region') {
      const scheme =
        groupBy.regionScheme === 'world_bank' ? 'World Bank regions' : 'world regions';
      if (groupBy.multiRegion === false) {
        sentences.push(
          `Results are grouped by ${scheme}: an organisation working across several regions is counted once under EACH of its regions, so the total across bars can be higher than the number of organisations. Countries that can't be recognised fall under "Unknown".`,
        );
      } else {
        sentences.push(
          `Results are grouped by ${scheme}: each organisation is placed in ONE region bucket based on its countries — organisations working across several regions appear once under "Multi-region", and countries that can't be recognised fall under "Unknown".`,
        );
      }
    } else if (isCountryLabel(groupLabel)) {
      sentences.push(
        `Results are broken down by ${lowerFirst(groupLabel)}. An organisation working in several countries is counted once under each of its countries, so the total across rows can be higher than the number of organisations.`,
      );
    } else {
      sentences.push(`Results are broken down by ${lowerFirst(groupLabel)}.`);
    }
  }

  // --- Time bucket ---------------------------------------------------------
  if (config.timeBucket?.field) {
    const granularity = GRANULARITY_LABEL[config.timeBucket.granularity] || 'period';
    const tbLabel =
      resolveLabel(
        {
          field: config.timeBucket.field,
          fieldKind: config.timeBucket.fieldKind || 'system',
          fieldId: config.timeBucket.fieldId,
        },
        fieldLabel,
      ) || humaniseFieldName(config.timeBucket.field);
    let sentence = `Values are shown over time by ${granularity}, based on ${lowerFirst(tbLabel)}.`;
    const win = config.timeBucket.window;
    if (win && Number(win.amount) >= 1 && win.unit) {
      const amount = Number(win.amount);
      const unitLabel = GRANULARITY_LABEL[win.unit] || win.unit;
      sentence += amount === 1
        ? ` Only the current ${unitLabel} is shown.`
        : ` Only the last ${amount} ${unitLabel}s are shown, rolling forward automatically.`;
    }
    if (config.cumulative) {
      sentence += ' Each point is a running total that includes all earlier periods.';
    }
    sentences.push(sentence);
  }

  // --- Filters -------------------------------------------------------------
  const filters = Array.isArray(config.filters) ? config.filters : [];
  if (filters.length > 0) {
    const clauses = filters.map(f => describeFilter(f, fieldLabel, valueLabel));
    if (clauses.length === 1) {
      sentences.push(`Only includes records where ${clauses[0]}.`);
    } else {
      sentences.push(`Only includes records where ${clauses.join(', and ')}.`);
    }
  }

  // --- Widget-type nuance ----------------------------------------------------
  if (widgetType === 'stat' && !groupBy && !config.timeBucket?.field) {
    // single number — nothing extra to add
  }

  return sentences.join(' ');
}

export default describeWidgetConfig;
