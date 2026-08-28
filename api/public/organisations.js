import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import {
  filterOrganizationsEligibleForFields,
  normalizeOrganizationPreferenceValue,
  VALID_ORGANIZATION_CORE_FIELDS,
} from '../_lib/organizationEligibility.js';
import { resolveConditionalFilter } from '../_lib/formConditionalFilters.js';
import {
  isRepeatableRowField,
  repeatableRowChildren,
} from '../../shared/formRepeatableRows.js';

/**
 * Resolves a dynamic organisation dropdown exclusively from the saved form.
 * A bad/stale request deliberately returns no options: callers must never get
 * a broader organisation list because a conditional configuration could not be
 * loaded or interpreted.
 */
export async function loadConditionalOrganizationOptions({
  db, tenantId, formId, formSlug, fieldId, containerFieldId, sourceAnswers,
}) {
  if (!db || !tenantId || !fieldId || !sourceAnswers
      || typeof sourceAnswers !== 'object' || Array.isArray(sourceAnswers)
      || (!formId && !formSlug)) return [];
  try {
    let formQuery = db.from('form')
      .select('id, fields')
      .eq('tenant_id', tenantId)
      .eq('is_active', true);
    formQuery = formId ? formQuery.eq('id', formId) : formQuery.eq('slug', formSlug);
    const { data: form, error: formError } = await formQuery.maybeSingle();
    if (formError || !form || !Array.isArray(form.fields)) return [];
    let fields = form.fields;
    let field = fields.find((candidate) => String(candidate?.id) === String(fieldId));
    // A row child is never addressable as a top-level field. The container ID
    // selects a saved repeatable field first, then the child is resolved only
    // from that field's persisted children. This prevents callers from using a
    // child ID to obtain options from another container or form scope.
    if (containerFieldId !== undefined && containerFieldId !== null && containerFieldId !== '') {
      const container = form.fields.find(
        (candidate) => String(candidate?.id) === String(containerFieldId),
      );
      if (!container || !isRepeatableRowField(container)) return [];
      fields = repeatableRowChildren(container);
      field = fields.find((candidate) => String(candidate?.id) === String(fieldId));
    }
    if (!field || field.type !== 'organisation_dropdown') return [];
    const groupParentId = field.organisation_group_parent_field_id;
    let selectedGroupId = null;
    if (groupParentId) {
      const fieldIndex = fields.findIndex(candidate => String(candidate?.id) === String(field.id));
      const parentIndex = fields.findIndex(candidate => String(candidate?.id) === String(groupParentId));
      const parent = fields[parentIndex];
      if (parentIndex < 0 || parentIndex >= fieldIndex
          || parent?.type !== 'organisation_group_dropdown') return [];
      const rawGroupId = sourceAnswers[groupParentId];
      if (!rawGroupId || rawGroupId === '__form_not_listed__' || typeof rawGroupId !== 'string') return [];
      const { data: group, error: groupError } = await db
        .from('organization_group')
        .select('id')
        .eq('id', rawGroupId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (groupError || !group) return [];
      selectedGroupId = String(group.id);
    }

    const resolution = resolveConditionalFilter(field, sourceAnswers, fields);
    // Absent/empty rules retain the historical static-filter behavior. A
    // configured set with no matched rule (or invalid persisted shape) has an
    // empty allowed set and is therefore closed by the filter below.
    if (resolution.configured && (!resolution.valid || !resolution.rule)) return [];

    let organizationsQuery = db
      .from('organization')
      .select('*')
      .eq('tenant_id', tenantId)
    if (selectedGroupId) organizationsQuery = organizationsQuery.eq('organization_group_id', selectedGroupId);
    const { data: organizations, error: organizationsError } = await organizationsQuery
      .order('name', { ascending: true });
    if (organizationsError) return [];

    const allowedIds = resolution.configured && Array.isArray(resolution.allowedValues)
      ? new Set(resolution.allowedValues.map((value) => String(value))) : null;
    // null means the matched rule supplied no ID restriction; an empty Set
    // means a configured ID list intersected the saved base choices to none.
    const idEligible = allowedIds
      ? (organizations || []).filter((organization) => allowedIds.has(String(organization.id)))
      : (organizations || []);
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
  } catch {
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
    const { tenant: tenantParam, allowedStatuses: allowedStatusesParam, orgFilter: orgFilterParam } = req.query || {};
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
        if (parsed && parsed.type && parsed.field && Array.isArray(parsed.values) && parsed.values.length > 0) {
          orgFilter = parsed;
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
      });
      return res.json(data);
    }

    if (orgFilter && orgFilter.type === 'core') {
      if (!VALID_ORGANIZATION_CORE_FIELDS.includes(orgFilter.field)) {
        return res.status(400).json({ error: 'Invalid core field for filtering' });
      }

      const sanitizedValues = orgFilter.values
        .map(v => String(v).trim())
        .filter(v => v.length > 0 && v.length <= 200);

      if (sanitizedValues.length === 0) {
        return res.status(400).json({ error: 'No valid filter values provided' });
      }

      let query = supabase
        .from('organization')
        .select('id, name, logo_url')
        .eq('tenant_id', tenantId);

      if (orgFilter.field === 'is_active') {
        const boolVal = sanitizedValues[0] === 'true';
        query = query.eq('is_active', boolVal);
      } else {
        query = query.in(orgFilter.field, sanitizedValues);
      }

      const { data, error } = await query.order('name', { ascending: true });
      if (error) {
        console.error('Error fetching organisations with core filter:', error);
        return res.status(500).json({ error: error.message });
      }
      return res.json(data || []);
    }

    if (orgFilter && orgFilter.type === 'custom') {
      return await filterByCustomField(supabase, tenantId, orgFilter.field, orgFilter.values, res);
    }

    if (allowedStatuses.length > 0) {
      return await filterByCustomField(supabase, tenantId, 'application_status', allowedStatuses, res);
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
    return res.status(500).json({ error: 'Failed to fetch organisations' });
  }
}

export default function handler(req, res) {
  return organizationsHandler(req, res);
}

async function filterByCustomField(supabase, tenantId, fieldName, allowedValues, res) {
  const { data: prefField, error: fieldError } = await supabase
    .from('preference_field')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', fieldName)
    .eq('entity_scope', 'organization')
    .eq('is_active', true)
    .single();

  if (fieldError || !prefField) {
    const { data, error } = await supabase
      .from('organization')
      .select('id, name, logo_url')
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  }

  const { data: allOrgs, error: orgsError } = await supabase
    .from('organization')
    .select('id, name, logo_url')
    .eq('tenant_id', tenantId)
    .order('name', { ascending: true });

  if (orgsError) {
    console.error('Error fetching organisations:', orgsError);
    return res.status(500).json({ error: orgsError.message });
  }

  const orgIds = (allOrgs || []).map(org => org.id);
  if (orgIds.length === 0) return res.json([]);

  const { data: prefValues, error: prefError } = await supabase
    .from('organization_preference_value')
    .select('organization_id, value')
    .eq('field_id', prefField.id)
    .in('organization_id', orgIds);

  if (prefError) {
    console.error('Error fetching org preference values:', prefError);
    return res.json(allOrgs || []);
  }

  const orgValueMap = {};
  (prefValues || []).forEach(pv => {
    orgValueMap[pv.organization_id] = normalizeOrganizationPreferenceValue(pv.value);
  });

  const normalizedAllowed = allowedValues.map(s => String(s));
  const filteredOrgs = (allOrgs || []).filter(org => {
    const orgVal = orgValueMap[org.id];
    if (orgVal === null || orgVal === undefined) return false;
    return normalizedAllowed.includes(orgVal);
  });

  return res.json(filteredOrgs);
}
