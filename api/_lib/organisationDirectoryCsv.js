import { CSV_BOM, CSV_ROW_SEPARATOR, escapeCsvCell } from './csvCell.js';
import { normalizeOrganizationPreferenceValues } from './organizationEligibility.js';
import { COUNTRIES, resolveCountryToIso2 } from '../../shared/countries.js';

function scalarValues(raw) {
  return normalizeOrganizationPreferenceValues(raw) || [];
}

export function formatOrganisationDirectoryCsvValue(raw, field) {
  // File values are storage descriptors.  A directory export may acknowledge
  // their presence, but must not disclose paths, buckets, signed URLs, or the
  // descriptor's other metadata.
  if (['file', 'image', 'images', 'attachment'].includes(String(field.field_type).toLowerCase())) {
    return scalarValues(raw).some((value) => String(value).trim()) ? 'File' : '';
  }
  const values = scalarValues(raw);
  if (String(field.field_type).toLowerCase() === 'boolean') {
    if (!values.length) return '';
    return ['true', 'yes', '1'].includes(String(values[0]).trim().toLowerCase()) ? 'Yes' : 'No';
  }
  let rawOptions = field.options;
  if (typeof rawOptions === 'string') {
    try { rawOptions = JSON.parse(rawOptions); } catch { rawOptions = []; }
  }
  const optionLabels = new Map((Array.isArray(rawOptions) ? rawOptions : []).flatMap((option) => {
    const value = option && typeof option === 'object' ? option.value : option;
    const label = option && typeof option === 'object' ? (option.label ?? option.value) : option;
    return ['string', 'number', 'boolean'].includes(typeof value)
      ? [[String(value), String(label ?? value)]] : [];
  }));
  const countryNames = new Map(COUNTRIES.map((country) => [country.code, country.name]));
  const isCountry = ['country', 'countries'].includes(String(field.field_type).toLowerCase());
  return [...new Set(values.map((value) => {
    const normalized = String(value);
    const country = isCountry && resolveCountryToIso2(normalized);
    return optionLabels.get(normalized) ?? (country ? countryNames.get(country) : normalized);
  }).filter((value) => value.trim()))].join('; ');
}

function safeLogoValue(raw) {
  // A logo is visual front-card content, not a grant to disclose an upload
  // descriptor or a bearer/signed URL.  Bare permanent web URLs are safe to
  // include; all other nonempty logo shapes retain only a presence marker.
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw !== 'string') return 'Logo available';
  const value = raw.trim();
  if (!value || /[\r\n]/.test(value) || value.startsWith('{') || value.startsWith('[')) {
    return value ? 'Logo available' : '';
  }
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && !url.search && !url.hash) return url.href;
    return 'Logo available';
  } catch {
    return 'Logo available';
  }
}

function uniqueHeaders(columns) {
  const used = new Set();
  const nextSuffix = new Map();
  return columns.map((column) => {
    const base = String(column.label || 'Field').trim() || 'Field';
    let count = nextSuffix.get(base) || 1;
    let candidate = count === 1 ? base : `${base} (${count})`;
    while (used.has(candidate)) {
      count += 1;
      candidate = `${base} (${count})`;
    }
    used.add(candidate);
    nextSuffix.set(base, count + 1);
    return candidate;
  });
}

/**
 * Build a complete CSV in memory before an HTTP response is committed.  This
 * intentionally prevents a query/projection failure from becoming a successful
 * but truncated download.
 */
export function organisationDirectoryCsvSourceKey(field) {
  const source = field._source;
  return source ? `${source.relationship_id}:${source.direction}:${source.object_id}` : null;
}

export function organisationDirectoryCsvSourceExpands(field) {
  const source = field._source;
  if (field._kind !== 'object' || !source) return false;
  const cardinality = source.cardinality || 'many_to_many';
  return cardinality === 'many_to_many'
    || (cardinality === 'one_to_many' && source.direction === 'source')
    || (cardinality === 'many_to_one' && source.direction === 'target');
}

function organizationRows(organization, fields, objectValues) {
  const sources = new Map();
  for (const field of fields) {
    if (!organisationDirectoryCsvSourceExpands(field)) continue;
    const sourceKey = organisationDirectoryCsvSourceKey(field);
    if (!sources.has(sourceKey)) sources.set(sourceKey, new Map());
    for (const entry of objectValues.get(field.key)?.get(String(organization.id)) || []) {
      if (!entry.recordId) throw new Error('Directory export record identity is missing');
      sources.get(sourceKey).set(String(entry.recordId), {
        sourceKey, recordId: String(entry.recordId), objectId: field._source.object_id,
      });
    }
  }
  const rows = [...sources.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .flatMap(([, records]) => [...records.values()].sort((a, b) =>
      a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
  return rows.length ? rows : [null];
}

export function countOrganisationDirectoryCsvRows({ organizations, fields, objectValues, maxRows = 100000 }) {
  let count = 0;
  for (const organization of organizations) {
    count += organizationRows(organization, fields, objectValues).length;
    if (count > maxRows) throw new Error('Organisation directory expanded export exceeds the supported row limit');
  }
  return count;
}

export function projectOrganisationDirectoryCsv({
  organizations,
  fields,
  preferences,
  objectValues,
  memberValues,
  includeLogo = false,
  includeOrganisation = true,
  maxRows = 100000,
}) {
  const exportFields = fields.filter((field) => field.key !== 'org_members_list');
  if (!exportFields.some((field) => field.key === 'org_member_count')) {
    exportFields.push({ key: 'org_member_count', label: 'Number of members', _kind: 'core' });
  }
  countOrganisationDirectoryCsvRows({ organizations, fields: exportFields, objectValues, maxRows });
  // These are the actual front-card values in visual order (logo then title),
  // followed by the configured back-field order. Domains are searchable
  // directory metadata but are not rendered on this card, so are not exported.
  const columns = [
    ...(includeLogo ? [{ label: 'Logo', value: (organization) => safeLogoValue(organization.logo_url) }] : []),
    ...(includeOrganisation ? [{ label: 'Organisation', value: (organization) => String(organization.name || '') }] : []),
    ...exportFields.map((field) => ({
      label: field.key === 'org_member_count' ? 'Number of members' : field.label,
      value: (organization, row) => {
        if (field._kind === 'custom') {
          return formatOrganisationDirectoryCsvValue(
            preferences.get(`${organization.id}:${field._field.id}`) || [], field,
          );
        }
        if (field._kind === 'object') {
          let entries = objectValues.get(field.key)?.get(String(organization.id)) || [];
          if (organisationDirectoryCsvSourceExpands(field)) {
            if (!row || row.sourceKey !== organisationDirectoryCsvSourceKey(field)) return '';
            entries = entries.filter((entry) => String(entry.recordId) === row.recordId);
          }
          const seen = new Set();
          return entries.map((entry) => {
            if (entry.recordId && seen.has(String(entry.recordId))) return '';
            if (entry.recordId) seen.add(String(entry.recordId));
            return String(entry?.value || '');
          }).filter(Boolean).join('; ');
        }
        if (field.key === 'org_member_count') {
          if (row) {
            const count = memberValues.recordCounts?.get(`${organization.id}:${row.objectId}:${row.recordId}`);
            return count === undefined || count === null ? '' : String(count);
          }
          return String(memberValues.counts.get(String(organization.id)) || 0);
        }
        return '';
      },
    })),
  ];
  const headers = uniqueHeaders(columns);
  const rows = organizations.flatMap((organization) =>
    organizationRows(organization, exportFields, objectValues)
      .map((row) => columns.map((column) => column.value(organization, row))));
  const text = [headers, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join(CSV_ROW_SEPARATOR);
  return `${CSV_BOM}${text}`;
}