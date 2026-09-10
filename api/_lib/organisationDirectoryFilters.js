import { createHash } from 'node:crypto';
import { COUNTRIES, resolveCountryToIso2 } from '../../shared/countries.js';
import {
  ORG_DIRECTORY_FILTER_SETTING,
  isOrganisationDirectoryFieldFilterable,
  parseOrganisationDirectoryFilterOverrides,
} from '../../shared/organisationDirectoryFilters.js';
import {
  resolveCustomObjectDirectorySources,
} from './customObjectDirectory.js';
import {
  isVisibleInDirectory,
  ORG_BACK_DEFAULT_ORDER,
  parseDirVis,
  parseRoleIdArray,
  resolveBackFieldOrder,
} from './directoryConfig.js';
import { normalizeOrganizationPreferenceValues } from './organizationEligibility.js';

const PAGE_SIZE = 500;
const MAX_PAGES = 200;
const ID_CHUNK = 200;
const MAX_FILTERS = 50;
const CORE_FIELDS = Object.freeze([
  { key: 'org_member_count', label: 'Member count', field_type: 'number', control: 'number' },
  { key: 'org_members_list', label: 'Members / contacts list', field_type: 'text', control: 'text' },
]);

export class OrganisationDirectoryFilterError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function checked(query, message) {
  const result = await query;
  if (result.error) throw new Error(message || result.error.message);
  return result.data || [];
}

async function paged(build, message) {
  const output = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const start = page * PAGE_SIZE;
    const batch = await checked(build().range(start, start + PAGE_SIZE - 1), message);
    output.push(...batch);
    if (batch.length < PAGE_SIZE) return output;
  }
  throw new Error(message || 'Organisation directory query exceeded its supported inventory size');
}

async function chunked(ids, build, message) {
  const output = [];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
    output.push(...await checked(build(ids.slice(offset, offset + ID_CHUNK)), message));
  }
  return output;
}

function savedArray(value) {
  if (value === undefined || value === null) return [];
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
}

function savedFalse(value) {
  return value === false || String(value).toLowerCase() === 'false';
}

function parseOptions(raw) {
  let options = raw;
  if (typeof options === 'string') {
    try { options = JSON.parse(options); } catch { return []; }
  }
  if (!Array.isArray(options)) return [];
  const seen = new Set();
  return options.flatMap((option) => {
    const rawValue = isPlainObject(option) ? option.value : option;
    const rawLabel = isPlainObject(option) ? (option.label ?? option.value) : option;
    if (!['string', 'number', 'boolean'].includes(typeof rawValue)) return [];
    const value = String(rawValue);
    if (!value || seen.has(value)) return [];
    seen.add(value);
    return [{ value, label: String(rawLabel ?? rawValue) }];
  });
}

function countryOptions(field) {
  const selected = new Set(savedArray(field.selected_countries).map((code) => code.toUpperCase()));
  const countries = field.all_countries === false && selected.size
    ? COUNTRIES.filter(({ code }) => selected.has(code)) : COUNTRIES;
  return countries.map(({ code, name }) => ({ value: code, label: name }));
}

function fieldShape(type) {
  const normalized = String(type || 'text').toLowerCase();
  if (['select', 'dropdown', 'picklist', 'radio', 'checkbox', 'multiselect',
    'multi_select', 'multi-select', 'country', 'countries', 'boolean'].includes(normalized)) return 'choice';
  if (['number', 'decimal', 'integer', 'currency'].includes(normalized)) return 'number';
  if (['date', 'datetime', 'date_time'].includes(normalized)) return 'date';
  if (['file', 'image', 'images', 'attachment'].includes(normalized)) return 'presence';
  return 'text';
}

function metadataForField(field) {
  const key = `custom:${field.id}`;
  const control = fieldShape(field.field_type);
  let options = [];
  if (['country', 'countries'].includes(String(field.field_type))) {
    options = countryOptions(field);
  } else if (String(field.field_type) === 'boolean') {
    options = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];
  } else if (control === 'choice') {
    options = parseOptions(field.options);
  }
  return {
    key,
    label: String(field.label || field.name || 'Field'),
    field_type: String(field.field_type || 'text'),
    control,
    options,
    multi_select: ['multiselect', 'multi_select', 'multi-select', 'countries', 'checkbox']
      .includes(String(field.field_type)),
    _field: field,
    _kind: 'custom',
  };
}

function metadataForObjectSource(source) {
  const type = source.field?.field_type || 'text';
  const control = fieldShape(type);
  let options = [];
  if (['country', 'countries'].includes(type)) {
    options = countryOptions(source.field || {});
  } else if (type === 'boolean') {
    options = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];
  } else if (control === 'choice') {
    options = parseOptions(source.field?.options);
  }
  return {
    key: source.key,
    label: source.label,
    field_type: type,
    control,
    options,
    multi_select: ['list', 'countries'].includes(type),
    _source: source,
    _kind: 'object',
  };
}

function publicMetadata(field) {
  const { _field, _source, _kind, ...result } = field;
  return result;
}

async function loadSettings(db, tenantId) {
  const keys = [
    ORG_DIRECTORY_FILTER_SETTING,
    'org_directory_back_field_order',
    'org_directory_show_member_count',
    'org_directory_show_domains',
    'org_directory_show_logo',
    'org_directory_reverse_card_role_ids',
    'org_directory_excluded_orgs',
    'org_directory_allowed_application_statuses',
    'org_directory_visible_org_types',
  ];
  const rows = await checked(db.from('system_settings').select('setting_key, setting_value')
    .eq('tenant_id', tenantId).in('setting_key', keys), 'Failed to load organisation directory settings');
  if (rows.filter(({ setting_key }) =>
    setting_key === ORG_DIRECTORY_FILTER_SETTING).length > 1) {
    throw new OrganisationDirectoryFilterError(
      409,
      'Multiple organisation directory filter settings exist for this tenant; resolve the duplicate configuration',
    );
  }
  return new Map(rows.map((row) => [row.setting_key, row.setting_value]));
}

async function loadCustomFields(db, tenantId) {
  return paged(() => db.from('preference_field')
    .select('id, name, label, field_type, options, all_countries, selected_countries, is_filterable, directory_visibility, show_in_directory_card, display_order')
    .eq('tenant_id', tenantId).eq('entity_scope', 'organization').eq('is_active', true)
    .order('display_order', { ascending: true }).order('id', { ascending: true }),
  'Organisation directory field inventory exceeds the supported size');
}

async function buildInventory({
  db, context, settingsMode, isAdmin = false,
}) {
  const [settingMap, customFields, objectSources] = await Promise.all([
    loadSettings(db, context.tenantId),
    loadCustomFields(db, context.tenantId),
    resolveCustomObjectDirectorySources({
      db, context, settings: settingsMode, isAdmin,
    }),
  ]);
  const rawOverrides = settingMap.has(ORG_DIRECTORY_FILTER_SETTING)
    ? settingMap.get(ORG_DIRECTORY_FILTER_SETTING) : undefined;
  let overrides;
  try {
    overrides = parseOrganisationDirectoryFilterOverrides(rawOverrides);
  } catch {
    throw new OrganisationDirectoryFilterError(500, 'Saved organisation directory filter configuration is malformed');
  }

  const visibleCustom = customFields.flatMap((field) => {
    const visibility = parseDirVis(field);
    const assigned = visibility
      ? isVisibleInDirectory(field, 'main') : field.show_in_directory_card !== false;
    if (!assigned) return [];
    const display = visibility?.display?.main;
    if (display && typeof display === 'object' && display.back === false) return [];
    const label = visibility?.labels?.main;
    return [{
      ...field,
      ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
    }];
  });
  const settingsCustomMetadata = customFields.map(metadataForField);
  const customMetadata = visibleCustom.map(metadataForField);
  const objectMetadata = objectSources.map(metadataForObjectSource);
  const settingsCoreMetadata = CORE_FIELDS.map((field) => ({
    ...field, options: [], multi_select: false, _kind: 'core',
  }));
  const coreMetadata = CORE_FIELDS.filter((field) => (
    field.key !== 'org_member_count'
      || !savedFalse(settingMap.get('org_directory_show_member_count'))
  )).map((field) => ({ ...field, options: [], multi_select: false, _kind: 'core' }));
  const all = [...coreMetadata, ...customMetadata, ...objectMetadata];
  const savedOrder = savedArray(settingMap.get('org_directory_back_field_order'));
  const orderFields = (fields, orderedCustomFields) => {
    const byKey = new Map(fields.map((field) => [field.key, field]));
    const resolved = resolveBackFieldOrder({
      directoryOrder: null,
      tenantOrder: savedOrder,
      defaultOrder: ORG_BACK_DEFAULT_ORDER,
      customFields: orderedCustomFields,
      objectSources,
    });
    const ordered = resolved.map((key) => byKey.get(key)).filter(Boolean);
    for (const field of fields) if (!ordered.includes(field)) ordered.push(field);
    return ordered;
  };
  return {
    fields: orderFields(all, visibleCustom),
    settingsFields: orderFields(
      [...settingsCoreMetadata, ...settingsCustomMetadata, ...objectMetadata],
      customFields,
    ),
    overrides,
    settingMap,
  };
}

function nonempty(value) {
  if (Array.isArray(value)) return value.some(nonempty);
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function scalarValues(raw, fieldType) {
  const values = normalizeOrganizationPreferenceValues(raw) || [];
  if (['country', 'countries'].includes(String(fieldType))) {
    return values.map((value) => resolveCountryToIso2(value) || String(value));
  }
  return values;
}

function comparable(value, type) {
  if (['number', 'decimal', 'integer', 'currency'].includes(String(type))) {
    if ((typeof value !== 'number' && typeof value !== 'string')
        || (typeof value === 'string' && !value.trim())) return NaN;
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }
  if (['date', 'datetime', 'date_time'].includes(String(type))) return Date.parse(value);
  if (String(type) === 'boolean') {
    const normalized = String(value).trim().toLowerCase();
    if (['true', 'yes', '1'].includes(normalized)) return 'true';
    if (['false', 'no', '0'].includes(normalized)) return 'false';
  }
  return String(value).trim().toLocaleLowerCase();
}

export function matchesOrganisationDirectoryFilter(rawValues, filter, metadata) {
  const values = Array.isArray(rawValues) ? rawValues.flatMap((value) =>
    scalarValues(value, metadata.field_type)) : scalarValues(rawValues, metadata.field_type);
  if (filter.operator === 'present') return values.some(nonempty);
  if (filter.operator === 'absent') return !values.some(nonempty);
  const wanted = Array.isArray(filter.value) ? filter.value : [filter.value];
  if (filter.operator === 'between') {
    const actual = values.map((value) => comparable(value, metadata.field_type))
      .filter(Number.isFinite);
    const low = comparable(filter.value[0], metadata.field_type);
    const high = comparable(filter.value[1], metadata.field_type);
    return Number.isFinite(low) && Number.isFinite(high)
      && actual.some((value) => value >= low && value <= high);
  }
  return values.some((value) => {
    const actual = comparable(value, metadata.field_type);
    if (filter.operator === 'contains') {
      return wanted.some((candidate) => String(value).toLocaleLowerCase()
        .includes(String(candidate).toLocaleLowerCase()));
    }
    if (filter.operator === 'gte') {
      const candidate = comparable(wanted[0], metadata.field_type);
      return Number.isFinite(actual) && Number.isFinite(candidate) && actual >= candidate;
    }
    if (filter.operator === 'lte') {
      const candidate = comparable(wanted[0], metadata.field_type);
      return Number.isFinite(actual) && Number.isFinite(candidate) && actual <= candidate;
    }
    return wanted.some((candidate) => actual === comparable(candidate, metadata.field_type));
  });
}

function validateRequest(input, fieldByKey) {
  if (!isPlainObject(input)) throw new OrganisationDirectoryFilterError(400, 'JSON body is required');
  const filters = input.filters ?? {};
  if (!isPlainObject(filters) || Object.keys(filters).length > MAX_FILTERS) {
    throw new OrganisationDirectoryFilterError(400, 'filters must be an object with at most 50 fields');
  }
  const output = {};
  for (const [key, filter] of Object.entries(filters)) {
    const metadata = fieldByKey.get(key);
    if (!metadata) throw new OrganisationDirectoryFilterError(400, `Filter field is unavailable: ${key}`);
    const allowedOperators = {
      choice: new Set(['eq']),
      presence: new Set(['present', 'absent']),
      text: new Set(['eq', 'contains', 'present', 'absent']),
      number: new Set(['eq', 'gte', 'lte', 'between', 'present', 'absent']),
      date: new Set(['eq', 'gte', 'lte', 'between', 'present', 'absent']),
    }[metadata.control];
    if (!isPlainObject(filter) || !allowedOperators?.has(filter.operator)) {
      throw new OrganisationDirectoryFilterError(400, `Invalid filter for field: ${key}`);
    }
    if (['present', 'absent'].includes(filter.operator)) {
      output[key] = { operator: filter.operator };
      continue;
    }
    if (filter.value === undefined || JSON.stringify(filter.value).length > 10000) {
      throw new OrganisationDirectoryFilterError(400, `Filter value is required: ${key}`);
    }
    if (metadata.control === 'choice') {
      if (filter.operator !== 'eq'
          || (!Array.isArray(filter.value)
            && !['string', 'number', 'boolean'].includes(typeof filter.value))) {
        throw new OrganisationDirectoryFilterError(400, `Invalid choice filter: ${key}`);
      }
      const requested = (Array.isArray(filter.value) ? filter.value : [filter.value])
        .map((value) => String(value).trim());
      if (!requested.length || requested.some((value) => !value)) {
        throw new OrganisationDirectoryFilterError(400, `Filter value is required: ${key}`);
      }
      const allowed = new Set(metadata.options.map((option) => option.value));
      if (requested.some((value) => !allowed.has(value))) {
        throw new OrganisationDirectoryFilterError(400, `Filter option is unavailable: ${key}`);
      }
      output[key] = {
        operator: 'eq',
        value: Array.isArray(filter.value) ? [...new Set(requested)] : requested[0],
      };
      continue;
    }
    if (metadata.control === 'text') {
      if (typeof filter.value !== 'string' || !filter.value.trim()) {
        throw new OrganisationDirectoryFilterError(400, `Text filter value is required: ${key}`);
      }
      output[key] = { operator: filter.operator, value: filter.value.trim() };
      continue;
    }
    const normalizeTyped = (value) => {
      if (value === null || (typeof value === 'string' && !value.trim()) || typeof value === 'boolean'
          || (typeof value !== 'string' && typeof value !== 'number')) return null;
      if (metadata.control === 'number') {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
      }
      const string = String(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(string)) return null;
      const timestamp = Date.parse(`${string}T00:00:00.000Z`);
      return Number.isFinite(timestamp)
        && new Date(timestamp).toISOString().slice(0, 10) === string ? string : null;
    };
    if (filter.operator === 'between') {
      if (!Array.isArray(filter.value) || filter.value.length !== 2) {
        throw new OrganisationDirectoryFilterError(400, `between requires two values: ${key}`);
      }
      const range = filter.value.map(normalizeTyped);
      if (range.some((value) => value === null)
          || comparable(range[0], metadata.field_type) > comparable(range[1], metadata.field_type)) {
        throw new OrganisationDirectoryFilterError(400, `Invalid filter range: ${key}`);
      }
      output[key] = { operator: filter.operator, value: range };
      continue;
    }
    const typedValue = normalizeTyped(filter.value);
    if (typedValue === null) {
      throw new OrganisationDirectoryFilterError(400, `Invalid filter value: ${key}`);
    }
    output[key] = { operator: filter.operator, value: typedValue };
  }
  const page = Number(input.page ?? 1);
  const pageSize = Number(input.pageSize ?? 12);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new OrganisationDirectoryFilterError(400, 'Invalid page or pageSize');
  }
  if (!['asc', 'desc'].includes(input.sort ?? 'asc')) {
    throw new OrganisationDirectoryFilterError(400, 'sort must be asc or desc');
  }
  if (typeof (input.search ?? '') !== 'string' || String(input.search ?? '').length > 500) {
    throw new OrganisationDirectoryFilterError(400, 'search must be a string of at most 500 characters');
  }
  return { filters: output, page, pageSize, sort: input.sort ?? 'asc', search: input.search ?? '' };
}

async function loadOrganizations(db, tenantId) {
  return paged(() => db.from('organization')
    .select('id, name, logo_url, domain')
    .eq('tenant_id', tenantId).order('id', { ascending: true }),
  'Organisation inventory exceeds the supported size');
}

async function loadPreferenceValues(db, organizationIds, fieldIds) {
  const output = [];
  for (let offset = 0; offset < organizationIds.length; offset += ID_CHUNK) {
    const ids = organizationIds.slice(offset, offset + ID_CHUNK);
    for (const fieldId of fieldIds) {
      output.push(...await paged(() => db.from('organization_preference_value')
        .select('organization_id, field_id, value').eq('field_id', fieldId)
        .in('organization_id', ids).order('organization_id', { ascending: true }),
      'Organisation preference values exceed the supported size'));
    }
  }
  return output;
}

function preferenceMap(rows) {
  const output = new Map();
  for (const row of rows) {
    const key = `${row.organization_id}:${row.field_id}`;
    const existing = output.get(key) || [];
    existing.push(row.value);
    output.set(key, existing);
  }
  return output;
}

async function objectValuesByOrganization(db, context, metadata, organizationIds) {
  const source = metadata._source;
  const orgColumn = `${source.direction}_record_id`;
  const recordColumn = source.direction === 'source' ? 'target_record_id' : 'source_record_id';
  const edges = [];
  for (let offset = 0; offset < organizationIds.length; offset += ID_CHUNK) {
    const ids = organizationIds.slice(offset, offset + ID_CHUNK);
    edges.push(...await paged(() => db.from('custom_object_relationship')
      .select(`${orgColumn}, ${recordColumn}`).eq('tenant_id', context.tenantId)
      .eq('relationship_definition_id', source.relationship_id).is('archived_at', null)
      .in(orgColumn, ids).order(recordColumn, { ascending: true }),
    'Custom Object relationship values exceed the supported size'));
  }
  const recordIds = [...new Set(edges.map((edge) => edge[recordColumn]).filter(Boolean))];
  const records = await chunked(recordIds, (ids) => db.from('custom_object_record')
    .select('id, data').eq('tenant_id', context.tenantId).eq('custom_object_id', source.object_id)
    .is('archived_at', null).in('id', ids), 'Failed to load Custom Object records');
  const recordsById = new Map(records.map((record) => [String(record.id), record]));
  const output = new Map();
  for (const edge of edges) {
    const record = recordsById.get(String(edge[recordColumn]));
    if (!record) continue;
    const raw = record.data?.[source._field?.name];
    // File/image filters expose presence only; storage descriptors never enter
    // metadata or the response projection.
    const value = metadata.control === 'presence' ? (nonempty(raw) ? true : null) : raw;
    const id = String(edge[orgColumn]);
    output.set(id, [...(output.get(id) || []), value]);
  }
  return output;
}

async function visibleMemberCore(db, context, settingMap, organizationIds) {
  const roleIds = parseRoleIdArray(settingMap.get('org_directory_reverse_card_role_ids'));
  const allowedListRoles = new Set(roleIds);
  const counts = new Map(organizationIds.map((id) => [String(id), 0]));
  const names = new Map(organizationIds.map((id) => [String(id), []]));
  if (!organizationIds.length) return { counts, names };
  for (let offset = 0; offset < organizationIds.length; offset += ID_CHUNK) {
    const ids = organizationIds.slice(offset, offset + ID_CHUNK);
    const rows = await paged(() => db.from('member')
      .select('id, organization_id, first_name, last_name, role_id').eq('tenant_id', context.tenantId)
      .in('organization_id', ids)
      .or('show_in_directory.is.null,show_in_directory.neq.false')
      .or('login_enabled.is.null,login_enabled.neq.false')
      .not('email', 'ilike', 'deleted_%@deleted.local').order('id', { ascending: true }),
    'Directory member inventory exceeds the supported size');
    for (const member of rows) {
      const organizationId = String(member.organization_id);
      counts.set(organizationId, (counts.get(organizationId) || 0) + 1);
      if (!allowedListRoles.has(String(member.role_id))) continue;
      const name = `${member.first_name || ''} ${member.last_name || ''}`.trim();
      names.get(organizationId)?.push(name);
    }
  }
  return { counts, names };
}

function matchesSavedEligibility(organization, ownId, exclusions, statusFieldIds, typeFieldIds,
  allowedStatuses, allowedTypes, values) {
  if (String(organization.id) === String(ownId || '')) return true;
  if (exclusions.has(String(organization.id))) return false;
  const matchesAny = (fieldIds, allowed) => fieldIds.some((fieldId) => (
    values.get(`${organization.id}:${fieldId}`) || []
  ).some((value) => scalarValues(value).some((item) => allowed.has(String(item)))));
  if (allowedStatuses.size && !matchesAny(statusFieldIds, allowedStatuses)) return false;
  if (allowedTypes.size && !matchesAny(typeFieldIds, allowedTypes)) return false;
  return true;
}

export function createOrganisationDirectoryFilters({ db, context, isAdmin = false }) {
  return {
    async metadata({ settings = false } = {}) {
      const inventory = await buildInventory({ db, context, settingsMode: settings, isAdmin });
      const enabled = settings ? inventory.settingsFields : inventory.fields.filter((field) =>
        isOrganisationDirectoryFieldFilterable(field.key, inventory.overrides, field._field));
      return {
        fields: enabled.map(publicMetadata),
        ...(settings ? { overrides: inventory.overrides } : {}),
      };
    },

    async search(input) {
      const inventory = await buildInventory({ db, context, settingsMode: false, isAdmin });
      const enabled = inventory.fields.filter((field) =>
        isOrganisationDirectoryFieldFilterable(field.key, inventory.overrides, field._field));
      const byKey = new Map(enabled.map((field) => [field.key, field]));
      const request = validateRequest(input, byKey);
      let organizations = await loadOrganizations(db, context.tenantId);
      const organizationIds = organizations.map(({ id }) => id);
      const customFilterFields = enabled.filter((field) =>
        request.filters[field.key] && field._kind === 'custom');

      const eligibilityFields = await checked(db.from('preference_field').select('id, name')
        .eq('tenant_id', context.tenantId).eq('entity_scope', 'organization')
        .in('name', ['application_status', 'org_type', 'organisation_type', 'organization_type']),
      'Failed to load organisation eligibility fields');
      const neededFieldIds = [...new Set([
        ...customFilterFields.map((field) => field._field.id),
        ...eligibilityFields.map((field) => field.id),
      ])];
      const preferences = preferenceMap(await loadPreferenceValues(db, organizationIds, neededFieldIds));
      const statusFieldIds = eligibilityFields.filter((field) => field.name === 'application_status').map((field) => field.id);
      const typeFieldIds = eligibilityFields.filter((field) =>
        ['org_type', 'organisation_type', 'organization_type'].includes(field.name)).map((field) => field.id);
      organizations = organizations.filter((organization) => matchesSavedEligibility(
        organization,
        context.organizationId,
        new Set(savedArray(inventory.settingMap.get('org_directory_excluded_orgs'))),
        statusFieldIds,
        typeFieldIds,
        new Set(savedArray(inventory.settingMap.get('org_directory_allowed_application_statuses'))),
        new Set(savedArray(inventory.settingMap.get('org_directory_visible_org_types'))),
        preferences,
      ));

      const eligibleIds = organizations.map(({ id }) => id);
      const showMemberCount = !savedFalse(
        inventory.settingMap.get('org_directory_show_member_count'),
      );
      const coreNeeded = showMemberCount
        || enabled.some((field) => request.filters[field.key] && field._kind === 'core');
      const memberValues = coreNeeded
        ? await visibleMemberCore(db, context, inventory.settingMap, eligibleIds)
        : { counts: new Map(), names: new Map() };
      const objectMaps = new Map();
      for (const field of enabled.filter((item) =>
        request.filters[item.key] && item._kind === 'object')) {
        objectMaps.set(field.key, await objectValuesByOrganization(db, context, field, eligibleIds));
      }
      organizations = organizations.filter((organization) => Object.entries(request.filters)
        .every(([key, filter]) => {
          const field = byKey.get(key);
          let values;
          if (field._kind === 'custom') values = preferences.get(`${organization.id}:${field._field.id}`) || [];
          else if (field._kind === 'object') values = objectMaps.get(key)?.get(String(organization.id)) || [];
          else {
            values = key === 'org_member_count'
              ? [memberValues.counts.get(String(organization.id)) || 0]
              : (memberValues.names.get(String(organization.id)) || []);
          }
          return matchesOrganisationDirectoryFilter(values, filter, field);
        }));
      const search = request.search.trim().toLocaleLowerCase();
      const showDomains = !savedFalse(inventory.settingMap.get('org_directory_show_domains'));
      const showLogo = !savedFalse(inventory.settingMap.get('org_directory_show_logo'));
      if (search) {
        organizations = organizations.filter((organization) =>
          [organization.name, ...(showDomains ? [organization.domain] : [])].some((value) =>
            String(value || '').toLocaleLowerCase().includes(search)));
      }
      organizations.sort((left, right) => {
        const compared = String(left.name || '').localeCompare(String(right.name || ''), undefined, {
          sensitivity: 'base',
        }) || String(left.id).localeCompare(String(right.id));
        return request.sort === 'asc' ? compared : -compared;
      });
      const total = organizations.length;
      const start = (request.page - 1) * request.pageSize;
      return {
        organizations: organizations.slice(start, start + request.pageSize).map((organization) => ({
          id: organization.id,
          name: organization.name,
          ...(showLogo ? { logo_url: organization.logo_url } : {}),
          ...(showDomains ? { domain: organization.domain } : {}),
          ...(showMemberCount ? {
            member_count: memberValues.counts.get(String(organization.id)) || 0,
          } : {}),
        })),
        total,
        page: request.page,
        pageSize: request.pageSize,
        fields: enabled.map(publicMetadata),
      };
    },
  };
}

export async function saveOrganisationDirectoryFilterOverrides({
  db, tenantId, changes, writableKeys,
}) {
  if (!isPlainObject(changes) || Object.keys(changes).length > 500
      || Object.entries(changes).some(([key, value]) =>
        !writableKeys.has(key) || typeof value !== 'boolean')) {
    throw new OrganisationDirectoryFilterError(400, 'changes contains an unknown field or non-boolean value');
  }
  const settingId = (() => {
    const hex = createHash('sha256')
      .update(`system_settings:${tenantId}:${ORG_DIRECTORY_FILTER_SETTING}`)
      .digest('hex').slice(0, 32).split('');
    hex[12] = '5';
    hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
    return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
  })();
  // Optimistic compare-and-swap prevents two settings tabs from silently
  // discarding each other's changes. A deterministic primary key serializes
  // concurrent first inserts even though legacy schemas do not universally
  // have a tenant_id/setting_key unique constraint.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await checked(db.from('system_settings').select('id, setting_value')
      .eq('tenant_id', tenantId).eq('setting_key', ORG_DIRECTORY_FILTER_SETTING).limit(2),
    'Failed to load organisation directory filter configuration');
    if (existing.length > 1) {
      throw new OrganisationDirectoryFilterError(
        409,
        'Multiple organisation directory filter settings exist for this tenant; resolve the duplicate configuration',
      );
    }
    const row = existing[0];
    let current;
    try {
      current = parseOrganisationDirectoryFilterOverrides(row?.setting_value);
    } catch {
      throw new OrganisationDirectoryFilterError(500, 'Saved organisation directory filter configuration is malformed');
    }
    const merged = { ...current, ...changes };
    if (!row) {
      const result = await db.from('system_settings').insert({
        id: settingId,
        tenant_id: tenantId,
        setting_key: ORG_DIRECTORY_FILTER_SETTING,
        setting_value: JSON.stringify(merged),
        setting_type: 'json',
        description: 'Organisation directory filterable back fields',
      }).select('id');
      if (!result.error) return merged;
      if (result.error.code === '23505') {
        const conflicting = await checked(db.from('system_settings')
          .select('tenant_id, setting_key').eq('id', settingId).limit(1),
        'Failed to verify concurrent organisation directory settings update');
        if (conflicting[0]?.tenant_id === tenantId
            && conflicting[0]?.setting_key === ORG_DIRECTORY_FILTER_SETTING) {
          continue;
        }
      }
      throw new Error(result.error.message || 'Failed to create organisation directory filter configuration');
    }
    let update = db.from('system_settings').update({
      setting_value: JSON.stringify(merged),
    }).eq('id', row.id).eq('tenant_id', tenantId);
    update = row.setting_value === null
      ? update.is('setting_value', null) : update.eq('setting_value', row.setting_value);
    const result = await update.select('id');
    if (result.error) throw new Error(result.error.message);
    if (result.data?.length) return merged;
  }
  throw new OrganisationDirectoryFilterError(409, 'Organisation directory filter settings changed concurrently; retry');
}