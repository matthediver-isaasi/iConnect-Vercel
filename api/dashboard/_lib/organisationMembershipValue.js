import { matchWidgetDateFilter } from './widgetFilterDates.js';

const SOURCE_ID = 'organisation_membership';
const HISTORY_TABLE = 'organisation_membership_history';
const PAGE_SIZE = 1000;
const MAX_ROWS = 50000;
const IN_FILTER_CHUNK = 200;

const INCLUDED_STATUSES = new Set(['active', 'scheduled', 'expired']);
const EXCLUDED_STATUSES = new Set([
  'cancelled', 'canceled', 'void', 'superseded',
  'draft', 'pending_payment_setup', 'payment_setup_required', 'expired_checkout',
]);
const FILTER_OPERATORS = new Set(['eq', 'neq', 'in', 'contains', 'is_null', 'is_not_null']);

function fail(message) {
  throw new Error(`Invalid annual membership value configuration: ${message}`);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function uniqueStrings(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 200) fail(`${name} must be an array of at most 200 IDs`);
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) fail(`${name} must contain non-empty string IDs`);
    const id = item.trim();
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/**
 * Validates and normalises the source-specific portion of a dashboard config.
 * The integration layer should call this from the dashboard zod refinement.
 */
export function validateOrganisationMembershipValueConfig(config) {
  const raw = config?.membershipValue;
  if (!plainObject(raw)) fail('membershipValue is required');
  if (!Number.isInteger(raw.startMonth) || raw.startMonth < 1 || raw.startMonth > 12) {
    fail('startMonth must be an integer from 1 to 12');
  }
  if (!Number.isInteger(raw.startYear) || raw.startYear < 1900 || raw.startYear > 9998) {
    fail('startYear must be an integer from 1900 to 9998');
  }
  let currency = null;
  if (raw.currency !== undefined && raw.currency !== null && raw.currency !== '') {
    if (typeof raw.currency !== 'string' || !/^[A-Za-z]{3}$/.test(raw.currency.trim())) {
      fail('currency must be a three-letter code');
    }
    currency = raw.currency.trim().toUpperCase();
  }
  const filters = config.filters ?? [];
  if (!Array.isArray(filters) || filters.length > 20) fail('filters must contain at most 20 entries');
  const normalisedFilters = filters.map((filter, index) => {
    if (!plainObject(filter) || filter.fieldKind !== 'custom' || typeof filter.fieldId !== 'string' || !filter.fieldId.trim()) {
      fail(`filter ${index + 1} must reference an organisation custom field`);
    }
    if (!FILTER_OPERATORS.has(filter.operator)) fail(`filter ${index + 1} uses an unsupported operator`);
    if (['eq', 'neq', 'contains'].includes(filter.operator) && filter.value === undefined) {
      fail(`filter ${index + 1} requires a value`);
    }
    if (filter.operator === 'in' && (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 200)) {
      fail(`filter ${index + 1} requires a non-empty array of at most 200 values`);
    }
    return {
      fieldKind: 'custom',
      fieldId: filter.fieldId.trim(),
      operator: filter.operator,
      ...(filter.value !== undefined ? { value: filter.value } : {}),
    };
  });
  return {
    startMonth: raw.startMonth,
    startYear: raw.startYear,
    currency,
    configIds: uniqueStrings(raw.configIds, 'configIds'),
    bandIds: uniqueStrings(raw.bandIds, 'bandIds'),
    filters: normalisedFilters,
  };
}

function queryWithTenant(client, table, columns, tenantId, count = true) {
  let query = client.from(table).select(columns, count ? { count: 'exact' } : undefined);
  query = tenantId ? query.eq('tenant_id', tenantId) : query.is('tenant_id', null);
  return query;
}

/**
 * Reads every row despite PostgREST/provider caps smaller than PAGE_SIZE.
 * An exact count makes a short page non-terminal; a missing page is an error,
 * never evidence of an empty/zero-valued dataset.
 */
async function readAll({
  client, table, columns, tenantId, apply = q => q, createQuery = null, maxRows = MAX_ROWS,
}) {
  let offset = 0;
  let expected = null;
  const rows = [];
  const ids = new Set();
  while (expected === null || offset < expected) {
    let query = createQuery
      ? createQuery()
      : apply(queryWithTenant(client, table, columns, tenantId));
    query = query.order('id', { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
    const { data, error, count } = await query;
    if (error) throw new Error(`Could not completely retrieve ${table}: ${error.message || error}`);
    if (expected === null) {
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`Could not verify complete retrieval of ${table}: exact count unavailable`);
      }
      expected = count;
      if (expected > maxRows) throw new Error(`${table} contains more than the ${maxRows} row scan limit`);
    } else if (Number.isInteger(count) && count !== expected) {
      throw new Error(`Could not consistently retrieve ${table}: row count changed during pagination`);
    }
    const page = Array.isArray(data) ? data : [];
    if (page.length === 0 && offset < expected) {
      throw new Error(`Could not completely retrieve ${table}: provider returned an incomplete page`);
    }
    for (const row of page) {
      const key = row?.id == null ? null : String(row.id);
      if (key && ids.has(key)) throw new Error(`Could not consistently retrieve ${table}: duplicate row ${key}`);
      if (key) ids.add(key);
      rows.push(row);
    }
    offset += page.length;
    if (rows.length > maxRows) throw new Error(`${table} contains more than the ${maxRows} row scan limit`);
  }
  if (rows.length !== expected) throw new Error(`Could not completely retrieve ${table}: expected ${expected}, received ${rows.length}`);
  return rows;
}

function periodFor({ startMonth, startYear }) {
  const start = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const end = new Date(Date.UTC(startYear + 1, startMonth - 1, 1));
  const lastDay = new Date(end.getTime() - 86400000).toISOString().slice(0, 10);
  return {
    start: start.toISOString().slice(0, 10),
    end: lastDay,
    endExclusive: end.toISOString().slice(0, 10),
    label: `${start.toISOString().slice(0, 10)} – ${lastDay}`,
  };
}

function decimal(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[3] || '';
  const units = BigInt(`${match[1] === '-' ? '-' : ''}${match[2]}${fraction}`);
  return { units, scale: fraction.length };
}

function sumDecimals(values) {
  const parsed = values.map(decimal);
  if (parsed.some(value => value === null)) return null;
  const scale = parsed.reduce((max, value) => Math.max(max, value.scale), 0);
  const units = parsed.reduce((sum, value) => sum + value.units * (10n ** BigInt(scale - value.scale)), 0n);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const padded = absolute.toString().padStart(scale + 1, '0');
  const integer = scale ? padded.slice(0, -scale) : padded;
  const fraction = scale ? padded.slice(-scale).replace(/0+$/, '') : '';
  const exact = `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
  const numeric = Number(exact);
  if (!Number.isFinite(numeric)) throw new Error('Annual membership value is outside the supported numeric range');
  return { exact, numeric };
}

function list(value) {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) return value.flatMap(list);
  if (plainObject(value)) {
    if ('value' in value) return list(value.value);
    return Object.values(value).flatMap(list);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if ((text.startsWith('[') || text.startsWith('{'))) {
      try { return list(JSON.parse(text)); } catch {}
    }
    return text ? [text] : [];
  }
  return [value];
}

function same(a, b) {
  return String(a).toLocaleLowerCase() === String(b).toLocaleLowerCase();
}

function filterMatches(value, filter) {
  const values = list(value);
  if (filter.operator === 'is_null') return values.length === 0;
  if (filter.operator === 'is_not_null') return values.length > 0;
  if (filter.valueType === 'date') {
    if (filter.operator === 'eq') {
      return values.some(item => matchWidgetDateFilter(item, filter));
    }
    if (filter.operator === 'neq') {
      return values.every(item => !matchWidgetDateFilter(item, { ...filter, operator: 'eq' }));
    }
  }
  if (filter.operator === 'eq') return values.some(item => same(item, filter.value));
  if (filter.operator === 'neq') return values.every(item => !same(item, filter.value));
  if (filter.operator === 'in') return values.some(item => filter.value.some(wanted => same(item, wanted)));
  if (filter.operator === 'contains') {
    const needle = String(filter.value).toLocaleLowerCase();
    return values.some(item => String(item).toLocaleLowerCase().includes(needle));
  }
  return false;
}

function warningCollector() {
  const warnings = new Map();
  return {
    add(code, message) {
      const current = warnings.get(code) || { code, message, count: 0 };
      current.count += 1;
      warnings.set(code, current);
    },
    values() { return [...warnings.values()]; },
  };
}

function recordStatus(record) {
  return String(record.status || '').trim().toLocaleLowerCase();
}

function snapshotConfig(record) {
  const config = record?.commitment_snapshot?.config;
  return plainObject(config) ? config : null;
}

async function loadClassification(client, tenantId, records, filters, fieldsById) {
  for (const filter of filters) {
    if (!fieldsById.has(filter.fieldId)) {
      throw new Error(`Classification field ${filter.fieldId} does not belong to this tenant's organisation fields`);
    }
  }
  if (!filters.length || !records.length) return new Set(records.map(row => row.id));
  const orgIds = [...new Set(records.map(row => row.organization_id).filter(Boolean))];
  const fieldIds = [...new Set(filters.map(filter => filter.fieldId))];
  const values = [];
  for (let offset = 0; offset < orgIds.length; offset += IN_FILTER_CHUNK) {
    const chunk = orgIds.slice(offset, offset + IN_FILTER_CHUNK);
    const remaining = MAX_ROWS - values.length;
    if (remaining <= 0) throw new Error(`organization_preference_value contains more than the ${MAX_ROWS} row scan limit`);
    const page = await readAll({
      client, table: 'organization_preference_value',
      columns: 'id, organization_id, field_id, value',
      tenantId,
      maxRows: remaining,
      // This legacy value table has no tenant_id. The inner organisation
      // relation provides tenant isolation, reinforced below by known org IDs.
      createQuery: () => {
        let q = client.from('organization_preference_value')
          .select('id, organization_id, field_id, value, organization:organization!inner(tenant_id)', { count: 'exact' })
          .in('organization_id', chunk)
          .in('field_id', fieldIds);
        q = tenantId ? q.eq('organization.tenant_id', tenantId) : q.is('organization.tenant_id', null);
        return q;
      },
    });
    values.push(...page);
  }
  const knownOrgs = new Set(orgIds);
  const byOrg = new Map();
  for (const row of values) {
    if (!knownOrgs.has(row.organization_id) || !fieldIds.includes(row.field_id)) continue;
    if (!byOrg.has(row.organization_id)) byOrg.set(row.organization_id, new Map());
    const org = byOrg.get(row.organization_id);
    if (!org.has(row.field_id)) org.set(row.field_id, []);
    org.get(row.field_id).push(row.value);
  }
  const matching = new Set();
  for (const record of records) {
    const prefs = byOrg.get(record.organization_id) || new Map();
    if (filters.every(filter => filterMatches(prefs.get(filter.fieldId) || null, filter))) matching.add(record.id);
  }
  return matching;
}

function optionsById(rows, label) {
  return rows.map(row => ({ value: row.id, label: label(row) }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}

async function loadCatalogRows(client, tenantId, includeHistory = false) {
  const [configs, bands, fields, history] = await Promise.all([
    readAll({ client, table: 'membership_tier_config', columns: 'id, name, currency, effective_from, effective_to', tenantId }),
    readAll({ client, table: 'membership_tier_band', columns: 'id, config_id, label, annual_cost', tenantId }),
    readAll({
      client, table: 'preference_field',
      columns: 'id, name, label, field_type, options, entity_scope, is_active',
      tenantId,
      apply: q => q.eq('entity_scope', 'organization').eq('is_active', true),
    }),
    includeHistory
      ? readAll({ client, table: HISTORY_TABLE, columns: 'id, currency', tenantId })
      : Promise.resolve([]),
  ]);
  return { configs, bands, fields, history };
}

/** Builder/catalog data for this bespoke source. */
export async function getOrganisationMembershipValueCatalog(client, tenantId) {
  const { configs, bands, fields, history } = await loadCatalogRows(client, tenantId, true);
  const configById = new Map(configs.map(row => [row.id, row]));
  const currencies = new Set();
  configs.forEach(row => row.currency && currencies.add(String(row.currency).toUpperCase()));
  history.forEach(row => row.currency && currencies.add(String(row.currency).toUpperCase()));
  return {
    id: SOURCE_ID,
    label: 'Annual Membership Value',
    structures: optionsById(configs, row => row.name || row.id),
    bands: bands.filter(row => configById.has(row.config_id)).map(row => ({
      value: row.id,
      label: `${configById.get(row.config_id).name || 'Structure'} — ${row.label || row.id}`,
      configId: row.config_id,
    })).sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value)),
    currencies: [...currencies].sort().map(value => ({ value, label: value })),
    customFields: fields.map(row => ({
      id: row.id,
      name: row.name,
      label: row.label || row.name,
      fieldType: row.field_type,
      options: row.options || null,
    })),
  };
}

/**
 * Calculates committed annual organisation membership value from durable
 * history rows. Payment state is deliberately not an eligibility condition.
 */
export async function runOrganisationMembershipValueWidget(config, tenantId, client) {
  if (!client) throw new Error('Database not configured');
  const settings = validateOrganisationMembershipValueConfig(config);
  const period = periodFor(settings);
  const [records, catalog] = await Promise.all([
    readAll({
      client, table: HISTORY_TABLE,
      columns: 'id, tenant_id, organization_id, status, payment_status, config_id, band_id, final_cost, currency, commitment_snapshot',
      tenantId,
    }),
    loadCatalogRows(client, tenantId),
  ]);
  const configById = new Map(catalog.configs.map(row => [row.id, row]));
  const bandById = new Map(catalog.bands.map(row => [row.id, row]));
  const fieldsById = new Map(catalog.fields.map(row => [row.id, row]));

  for (const id of settings.configIds) {
    if (!configById.has(id)) throw new Error(`Membership structure ${id} does not belong to this tenant`);
  }
  for (const id of settings.bandIds) {
    if (!bandById.has(id)) throw new Error(`Membership band ${id} does not belong to this tenant`);
  }

  const warnings = warningCollector();
  const lifecycleEligible = [];
  let excludedKnownLifecycle = 0;
  let excludedUnknownLifecycle = 0;
  for (const record of records) {
    const status = recordStatus(record);
    if (INCLUDED_STATUSES.has(status)) {
      lifecycleEligible.push(record);
    } else if (EXCLUDED_STATUSES.has(status)) {
      excludedKnownLifecycle += 1;
    } else {
      excludedUnknownLifecycle += 1;
      warnings.add(
        'unknown_lifecycle_status',
        'Some saved rows had an unrecognised or missing membership lifecycle status and were not valued.',
      );
    }
  }
  const matchingClassification = await loadClassification(
    client, tenantId, lifecycleEligible, settings.filters, fieldsById,
  );
  const selectedConfigIds = new Set(settings.configIds);
  const selectedBandIds = new Set(settings.bandIds);
  const amounts = [];
  const currencySet = new Set();
  let excludedByPeriod = 0;
  let excludedBySelection = 0;
  let excludedByClassification = 0;

  for (const record of lifecycleEligible) {
    if (!matchingClassification.has(record.id)) {
      excludedByClassification += 1;
      continue;
    }
    const snap = snapshotConfig(record);
    const verified = configById.get(record.config_id);
    const resolved = snap || verified;
    if (!resolved) {
      warnings.add('missing_structure_evidence', 'Some saved memberships have no snapshot or tenant-verified structure and were not valued.');
      continue;
    }
    const resolvedConfigId = resolved.id || record.config_id || null;
    if (selectedConfigIds.size && !selectedConfigIds.has(resolvedConfigId)) {
      excludedBySelection += 1;
      continue;
    }
    if (selectedBandIds.size && !selectedBandIds.has(record.band_id)) {
      excludedBySelection += 1;
      continue;
    }
    // The snapshot remains authoritative. A partial snapshot may borrow only
    // from the exact same config ID after tenant verification.
    const sameVerifiedConfig = snap?.id && record.config_id === snap.id && verified?.id === snap.id
      ? verified : null;
    const effectiveFrom = isoDate(resolved.effective_from)
      || isoDate(sameVerifiedConfig?.effective_from);
    if (!effectiveFrom) {
      warnings.add('missing_effective_from', 'Some saved memberships have no valid structure effective date and were not allocated.');
      continue;
    }
    if (effectiveFrom < period.start || effectiveFrom >= period.endExclusive) {
      excludedByPeriod += 1;
      continue;
    }
    const amount = decimal(record.final_cost);
    if (!amount || amount.units < 0n) {
      warnings.add('missing_final_cost', 'Some eligible saved memberships have no valid net final cost and were not valued.');
      continue;
    }
    const currency = String(
      record.currency
      || record.commitment_snapshot?.amounts?.currency
      || resolved.currency
      || sameVerifiedConfig?.currency
      || '',
    ).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      warnings.add('missing_currency', 'Some eligible saved memberships have no valid currency and were not valued.');
      continue;
    }
    if (settings.currency && currency !== settings.currency) {
      excludedBySelection += 1;
      continue;
    }
    currencySet.add(currency);
    amounts.push(String(record.final_cost));
  }

  if (!settings.currency && currencySet.size > 1) {
    throw new Error(`Annual membership value spans multiple currencies (${[...currencySet].sort().join(', ')}); select one currency`);
  }
  const total = sumDecimals(amounts) || { exact: '0', numeric: 0 };
  const currency = settings.currency || [...currencySet][0] || null;
  if (!amounts.length && warnings.values().length) {
    warnings.add('incomplete_zero', 'The displayed zero is incomplete because eligible records lacked valuation evidence.');
  }
  const warningValues = warnings.values();
  const membershipValue = {
    source: SOURCE_ID,
    period,
    allocation: 'membership_structure_effective_from_half_open',
    currency,
    exactValue: total.exact,
    netOfVat: true,
    includedRecords: amounts.length,
    excludedRecords: {
      lifecycle: excludedKnownLifecycle + excludedUnknownLifecycle,
      knownLifecycle: excludedKnownLifecycle,
      unknownLifecycle: excludedUnknownLifecycle,
      period: excludedByPeriod,
      selection: excludedBySelection,
      classification: excludedByClassification,
    },
    warnings: warningValues,
  };
  return {
    type: 'scalar',
    // Same semantics as the generic scalar path: total is contributing row
    // count; the monetary aggregate is value and rows[0].value.
    total: amounts.length,
    value: total.numeric,
    rows: [{ key: 'total', value: total.numeric }],
    membershipValue,
    // Mirrors consumed by the existing financial-stat card.
    available: !(amounts.length === 0 && warningValues.length > 0),
    currency,
    period,
    periodLabel: period.label,
    allocationBasis: membershipValue.allocation,
    allocationBasisLabel: 'Recorded value allocated by membership structure effective date',
    warnings: warningValues,
  };
}

export const ORGANISATION_MEMBERSHIP_VALUE_SOURCE_ID = SOURCE_ID;
export const ORGANISATION_MEMBERSHIP_VALUE_INCLUDED_STATUSES = Object.freeze([...INCLUDED_STATUSES]);
export const ORGANISATION_MEMBERSHIP_VALUE_EXCLUDED_STATUSES = Object.freeze([...EXCLUDED_STATUSES]);