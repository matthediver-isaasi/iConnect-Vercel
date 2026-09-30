import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import {
  filterOrganizationsEligibleForFields,
  VALID_ORGANIZATION_CORE_FIELDS,
} from '../_lib/organizationEligibility.js';
import { resolveConditionalFilter } from '../_lib/formConditionalFilters.js';
import {
  isRepeatableValueEmpty,
  isRepeatableRowField,
  normalizeRepeatableRowField,
  repeatableRowChildren,
} from '../../shared/formRepeatableRows.js';

const DIRECTORY_ORG_TYPE_SETTING = 'org_directory_visible_org_types';
const DIRECTORY_ORG_TYPE_FIELD_NAMES = ['org_type', 'organisation_type', 'organization_type'];
const ORGANIZATION_OPTIONS_PAGE_SIZE = 500;

function organisationAvailabilityUnavailable(cause) {
  const availabilityError = new Error('Organisation availability could not be resolved');
  availabilityError.code = 'ORGANISATION_AVAILABILITY_UNAVAILABLE';
  availabilityError.status = 503;
  if (cause) availabilityError.cause = cause;
  return availabilityError;
}

async function loadTenantOrganizationOptions({ db, tenantId, groupId = null }) {
  const organizations = [];
  for (let offset = 0; ; offset += ORGANIZATION_OPTIONS_PAGE_SIZE) {
    let query = db
      .from('organization')
      .select('*')
      .eq('tenant_id', tenantId);
    if (groupId) query = query.eq('organization_group_id', groupId);
    // Name is the user-facing order, while ID makes page boundaries stable
    // when multiple organisations share a name.
    query = query.order('name', { ascending: true });
    // Supabase query builders remain chainable. Keep terminal test doubles
    // compatible as a fail-closed fallback without weakening the production
    // name-then-ID ordering contract.
    if (typeof query?.order === 'function') {
      query = query.order('id', { ascending: true });
    }
    const paged = typeof query.range === 'function';
    const result = paged
      ? await query.range(offset, offset + ORGANIZATION_OPTIONS_PAGE_SIZE - 1)
      : await query;
    if (result?.error) throw result.error;
    const page = Array.isArray(result?.data) ? result.data : [];
    organizations.push(...page);
    if (!paged || page.length < ORGANIZATION_OPTIONS_PAGE_SIZE) break;
  }
  return organizations;
}

function parseSavedArray(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.map((item) => String(item).trim()).filter((item) => item && item.length <= 200)
    : [];
}

function hasAnsweredConditionalSource(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return hasAnsweredConditionalSource(value.value);
  }
  return !isRepeatableValueEmpty(value);
}

function conditionalSourcesAnswered(field, sourceAnswers, fields) {
  const sourceRules = (field?.conditional_filters?.rules || []).filter(rule => (
    rule && rule.is_fallback !== true
  ));
  if (sourceRules.length === 0) return false;
  return sourceRules.every(sourceRule => {
    const sourceField = (fields || []).find(candidate => (
      String(candidate?.id) === String(sourceRule.source_field_id)
    ));
    const sourceValue = Object.prototype.hasOwnProperty.call(
      sourceAnswers || {},
      sourceRule.source_field_id,
    )
      ? sourceAnswers[sourceRule.source_field_id]
      : sourceField?.name
        ? sourceAnswers?.[sourceField.name]
        : undefined;
    return hasAnsweredConditionalSource(sourceValue);
  });
}

async function resolveDirectoryOrgTypeFilter(db, tenantId) {
  const { data: settings, error: settingsError } = await db
    .from('system_settings')
    .select('setting_value')
    .eq('tenant_id', tenantId)
    .eq('setting_key', DIRECTORY_ORG_TYPE_SETTING);
  if (settingsError) throw settingsError;

  const values = parseSavedArray(settings?.[0]?.setting_value);
  if (values.length === 0) return { configured: false, filter: null };

  const { data: fields, error: fieldsError } = await db
    .from('preference_field')
    .select('name')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization')
    .eq('is_active', true)
    .in('name', DIRECTORY_ORG_TYPE_FIELD_NAMES);
  if (fieldsError) throw fieldsError;

  const availableNames = new Set((fields || []).map((field) => field.name));
  const fieldName = DIRECTORY_ORG_TYPE_FIELD_NAMES.find((name) => availableNames.has(name));
  return {
    configured: true,
    filter: fieldName ? { type: 'custom', field: fieldName, values } : null,
  };
}

/**
 * Resolves a dynamic organisation dropdown exclusively from the saved form.
 * A bad/stale ordinary request deliberately returns no options: callers must
 * never get a broader organisation list because a conditional configuration
 * could not be loaded or interpreted. Opted-in repeatable availability probes
 * return an explicit 503 on lookup failure so [] cannot be mistaken for an
 * authoritative empty domain.
 */
export async function loadConditionalOrganizationOptions({
  db,
  tenantId,
  formId,
  formSlug,
  fieldId,
  containerFieldId,
  sourceAnswers,
  availabilityProbe = false,
}) {
  if (!db || !tenantId || !fieldId || !sourceAnswers
      || typeof sourceAnswers !== 'object' || Array.isArray(sourceAnswers)
      || (!formId && !formSlug)) {
    if (availabilityProbe === true) {
      throw organisationAvailabilityUnavailable();
    }
    return [];
  }
  let isAvailabilityProbe = availabilityProbe === true;
  try {
    let formQuery = db.from('form')
      .select('id, fields')
      .eq('tenant_id', tenantId)
      .eq('is_active', true);
    formQuery = formId ? formQuery.eq('id', formId) : formQuery.eq('slug', formSlug);
    const { data: form, error: formError } = await formQuery.maybeSingle();
    if (formError || !form || !Array.isArray(form.fields)) {
      if (isAvailabilityProbe) throw organisationAvailabilityUnavailable(formError);
      return [];
    }
    let fields = form.fields;
    let container = null;
    let containerIndex = -1;
    let field = fields.find((candidate) => String(candidate?.id) === String(fieldId));
    // A row child is never addressable as a top-level field. The container ID
    // selects a saved repeatable field first, then the child is resolved only
    // from that field's persisted children. This prevents callers from using a
    // child ID to obtain options from another container or form scope.
    if (containerFieldId !== undefined && containerFieldId !== null && containerFieldId !== '') {
      containerIndex = form.fields.findIndex(
        (candidate) => String(candidate?.id) === String(containerFieldId),
      );
      container = form.fields[containerIndex];
      if (!container || !isRepeatableRowField(container)) {
        if (isAvailabilityProbe) throw organisationAvailabilityUnavailable();
        return [];
      }
      fields = repeatableRowChildren(container);
      field = fields.find((candidate) => String(candidate?.id) === String(fieldId));
    }
    if (!field || field.type !== 'organisation_dropdown') {
      if (isAvailabilityProbe) throw organisationAvailabilityUnavailable();
      return [];
    }
    const containerConfig = container && normalizeRepeatableRowField(container);
    isAvailabilityProbe = isAvailabilityProbe
      || (containerConfig?.hide_when_first_column_empty === true
        && String(containerConfig.children?.[0]?.id) === String(field.id));
    const groupParentId = field.organisation_group_parent_field_id;
    let selectedGroupId = null;
    if (groupParentId) {
      const scope = field.organisation_group_parent_scope
        ?? field.organisation_group_parent_field_scope ?? 'row';
      const parentFields = scope === 'form' ? form.fields : fields;
      const fieldIndex = fields.findIndex(candidate => String(candidate?.id) === String(field.id));
      const parentIndex = parentFields.findIndex(candidate => String(candidate?.id) === String(groupParentId));
      const parent = parentFields[parentIndex];
      const validScope = scope === 'row' || scope === 'form';
      const precedesParent = scope === 'form'
        ? container && parentIndex >= 0 && parentIndex < containerIndex
        : parentIndex >= 0 && parentIndex < fieldIndex;
      if (!validScope || !precedesParent
          || parent?.type !== 'organisation_group_dropdown') {
        if (isAvailabilityProbe) throw organisationAvailabilityUnavailable();
        return [];
      }
      const rawGroupId = sourceAnswers[groupParentId];
      if (!rawGroupId || rawGroupId === '__form_not_listed__' || typeof rawGroupId !== 'string') {
        if (isAvailabilityProbe) throw organisationAvailabilityUnavailable();
        return [];
      }
      const { data: group, error: groupError } = await db
        .from('organization_group')
        .select('id')
        .eq('id', rawGroupId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (groupError || !group) {
        if (isAvailabilityProbe) throw organisationAvailabilityUnavailable(groupError);
        return [];
      }
      selectedGroupId = String(group.id);
    }

    const resolution = resolveConditionalFilter(field, sourceAnswers, fields);
    // Absent/empty rules retain the historical static-filter behavior. A
    // configured set with no matched rule (or invalid persisted shape) has an
    // empty allowed set and is therefore closed by the filter below.
    if (resolution.configured && (!resolution.valid || !resolution.rule)) {
      // A valid conditional configuration with an answered source and no
      // matching rule is a confirmed empty domain, not a failed lookup.
      if (resolution.valid && conditionalSourcesAnswered(field, sourceAnswers, fields)) {
        return [];
      }
      if (isAvailabilityProbe) throw organisationAvailabilityUnavailable();
      return [];
    }

    const organizations = await loadTenantOrganizationOptions({
      db,
      tenantId,
      groupId: selectedGroupId,
    });

    const allowedIds = resolution.configured && Array.isArray(resolution.allowedValues)
      ? new Set(resolution.allowedValues.map((value) => String(value))) : null;
    const excludedIds = new Set(
      (resolution.excludedValues || []).map((value) => String(value)),
    );
    // null means the matched rule supplied no ID restriction; an empty Set
    // means a configured ID list intersected the saved base choices to none.
    const idEligible = allowedIds
      ? (organizations || []).filter((organization) => allowedIds.has(String(organization.id)))
      : (organizations || []).filter((organization) => !excludedIds.has(String(organization.id)));
    const eligible = await filterOrganizationsEligibleForFields({
      db,
      tenantId,
      organizations: idEligible,
      fields: resolution.orgFilter ? [field, { org_filter: resolution.orgFilter }] : [field],
    });
    return eligible.map((organization) => ({
      id: organization.id,
      name: organization.name,
      logo_url: organization.logo_url,
    }));
  } catch (error) {
    // A repeatable section that opted into availability hiding must never
    // receive a successful empty response for a failed option lookup: the
    // client would otherwise treat transport failure as an authoritative empty
    // domain and hide retained answers. Ordinary option requests preserve
    // their historical fail-closed [] behaviour.
    if (isAvailabilityProbe) {
      throw organisationAvailabilityUnavailable(error);
    }
    return [];
  }
}

export async function organizationsHandler(req, res, dependencies = {}) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let supabase = dependencies.db;
  if (!supabase) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    supabase = createClient(supabaseUrl, supabaseServiceKey);
  }

  try {
    const {
      tenant: tenantParam,
      allowedStatuses: allowedStatusesParam,
      orgFilter: orgFilterParam,
      directory: directoryParam,
    } = req.query || {};
    const applyDirectoryPolicy = directoryParam === 'true' || directoryParam === '1';
    let tenantId = null;

    let allowedStatuses = [];
    if (allowedStatusesParam) {
      try {
        allowedStatuses = JSON.parse(allowedStatusesParam);
        if (!Array.isArray(allowedStatuses)) allowedStatuses = [];
      } catch (e) { allowedStatuses = []; }
    }

    let orgFilter = null;
    if (orgFilterParam) {
      try {
        const parsed = JSON.parse(orgFilterParam);
        if (parsed?.mode !== undefined && !['include', 'exclude'].includes(parsed.mode)) {
          return res.status(400).json({ error: 'Invalid organisation filter mode' });
        }
        if (parsed && parsed.type && parsed.field && Array.isArray(parsed.values) && parsed.values.length > 0) {
          orgFilter = { ...parsed, mode: parsed.mode || 'include' };
        }
      } catch (e) { orgFilter = null; }
    }

    const tenant = await (dependencies.resolveTenant || resolveTenantFromRequest)(req);
    if (tenant) {
      tenantId = tenant.id;
    }

    if (!tenantId && tenantParam) {
      let { data: tenantBySlug } = await supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenantParam)
        .eq('status', 'active')
        .single();

      if (tenantBySlug) {
        tenantId = tenantBySlug.id;
      } else {
        const { data: tenantBySubdomain } = await supabase
          .from('tenant')
          .select('id')
          .eq('subdomain', tenantParam)
          .eq('status', 'active')
          .single();

        if (tenantBySubdomain) {
          tenantId = tenantBySubdomain.id;
        }
      }
    }

    if (!tenantId) {
      return res.status(400).json({ error: 'Invalid tenant context' });
    }

    if (req.method === 'POST') {
      const {
        formId: dynamicFormId,
        formSlug: dynamicFormSlug,
        fieldId,
        targetFieldId,
        containerFieldId,
        sourceAnswers,
      } = req.body || {};
      const dynamicFieldId = fieldId || targetFieldId;
      const data = await loadConditionalOrganizationOptions({
        db: supabase,
        tenantId,
        formId: dynamicFormId,
        formSlug: dynamicFormSlug,
        fieldId: dynamicFieldId,
        containerFieldId,
        sourceAnswers,
        availabilityProbe: req.body?.availabilityProbe === true,
      });
      return res.json(data);
    }

    const eligibilityFields = [];
    if (orgFilter) {
      if (!['core', 'custom'].includes(orgFilter.type)) {
        return res.status(400).json({ error: 'Invalid organisation filter type' });
      }
      if (orgFilter.type === 'core' && !VALID_ORGANIZATION_CORE_FIELDS.includes(orgFilter.field)) {
        return res.status(400).json({ error: 'Invalid core field for filtering' });
      }
      const sanitizedValues = orgFilter.values
        .map(v => String(v).trim())
        .filter(v => v.length > 0 && v.length <= 200);
      if (sanitizedValues.length === 0) {
        return res.status(400).json({ error: 'No valid filter values provided' });
      }
      eligibilityFields.push({ org_filter: { ...orgFilter, values: sanitizedValues } });
    }

    if (!orgFilter && allowedStatuses.length > 0) {
      const sanitizedStatuses = allowedStatuses
        .map(value => String(value).trim())
        .filter(value => value.length > 0 && value.length <= 200);
      if (sanitizedStatuses.length === 0) {
        return res.status(400).json({ error: 'No valid filter values provided' });
      }
      eligibilityFields.push({
        org_filter: {
          type: 'custom',
          field: 'application_status',
          values: sanitizedStatuses,
        },
      });
    }

    if (applyDirectoryPolicy) {
      const directoryTypePolicy = await resolveDirectoryOrgTypeFilter(supabase, tenantId);
      // A saved restriction whose field definition has disappeared must not
      // broaden the public directory until an administrator fixes the setting.
      if (directoryTypePolicy.configured && !directoryTypePolicy.filter) {
        return res.json([]);
      }
      if (directoryTypePolicy.filter) {
        eligibilityFields.push({ org_filter: directoryTypePolicy.filter });
      }
    }

    if (eligibilityFields.length > 0) {
      const { data: organizations, error } = await supabase
        .from('organization')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('name', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });
      const data = await filterOrganizationsEligibleForFields({
        db: supabase,
        tenantId,
        organizations,
        fields: eligibilityFields,
      });
      return res.json(data.map(({ id, name, logo_url }) => ({ id, name, logo_url })));
    }

    const { data, error } = await supabase
      .from('organization')
      .select('id, name, logo_url')
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true });

    if (error) {
      console.error('Error fetching organisations:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data || []);
  } catch (error) {
    console.error('Public organisations fetch error:', error);
    if (error?.code === 'ORGANISATION_AVAILABILITY_UNAVAILABLE') {
      return res.status(error.status || 503).json({
        error: error.message,
        code: error.code,
      });
    }
    return res.status(500).json({ error: 'Failed to fetch organisations' });
  }
}

export default function handler(req, res) {
  return organizationsHandler(req, res);
}
