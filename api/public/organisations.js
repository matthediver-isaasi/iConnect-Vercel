import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import {
  isOrganizationEligibleForField,
  normalizeOrganizationPreferenceValue,
  VALID_ORGANIZATION_CORE_FIELDS,
} from '../_lib/organizationEligibility.js';
import { resolveConditionalFilter } from '../_lib/formConditionalFilters.js';

/**
 * Resolves a dynamic organisation dropdown exclusively from the saved form.
 * A bad/stale request deliberately returns no options: callers must never get
 * a broader organisation list because a conditional configuration could not be
 * loaded or interpreted.
 */
export async function loadConditionalOrganizationOptions({
  db, tenantId, formId, formSlug, fieldId, sourceAnswers,
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
    const field = form.fields.find((candidate) => String(candidate?.id) === String(fieldId));
    if (!field || field.type !== 'organisation_dropdown') return [];

    const resolution = resolveConditionalFilter(field, sourceAnswers, form.fields);
    // Absent/empty rules retain the historical static-filter behavior. A
    // configured set with no matched rule (or invalid persisted shape) has an
    // empty allowed set and is therefore closed by the filter below.
    if (resolution.configured && (!resolution.valid || !resolution.rule)) return [];

    const { data: organizations, error: organizationsError } = await db
      .from('organization')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true });
    if (organizationsError) return [];

    const allowedIds = resolution.configured && Array.isArray(resolution.allowedValues)
      ? new Set(resolution.allowedValues.map((value) => String(value))) : null;
    const visible = [];
    for (const organization of organizations || []) {
      // null means the matched rule supplied no ID restriction; an empty Set
      // means a configured ID list intersected the saved base choices to none.
      if (allowedIds && !allowedIds.has(String(organization.id))) continue;
      if (!await isOrganizationEligibleForField({ db, tenantId, organization, field })) continue;
      if (resolution.orgFilter && !await isOrganizationEligibleForField({
        db, tenantId, organization, field: { org_filter: resolution.orgFilter },
      })) continue;
      visible.push({ id: organization.id, name: organization.name, logo_url: organization.logo_url });
    }
    return visible;
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
        sourceAnswers,
      } = req.body || {};
      const dynamicFieldId = fieldId || targetFieldId;
      const data = await loadConditionalOrganizationOptions({
        db: supabase,
        tenantId,
        formId: dynamicFormId,
        formSlug: dynamicFormSlug,
        fieldId: dynamicFieldId,
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
