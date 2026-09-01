import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { matchBand, isNumericFieldType, isTextFieldType, normalizeMatchValue } from '../_lib/tierBandMatcher.js';
import { getRemindersForConfig, saveRemindersForConfig } from '../_lib/membershipReminders.js';
import { normalizeInvoiceRecipients, validateInvoiceRecipientsShape } from '../_lib/membershipRecipientResolver.js';
import { parseFlatMembershipCost } from '../../shared/membershipFlatCost.js';

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function isConfigInEffect(config, onDate = todayStr()) {
  if (!config) return false;
  const startsOk = !config.effective_from || config.effective_from <= onDate;
  const endsOk = config.effective_to === null || config.effective_to === undefined || config.effective_to >= onDate;
  return startsOk && endsOk;
}

function configLifecycleStatus(config, onDate = todayStr()) {
  if (isConfigInEffect(config, onDate)) return 'active';
  if (config.effective_from && config.effective_from > onDate && (config.effective_to === null || config.effective_to === undefined)) {
    return 'scheduled';
  }
  return 'historical';
}

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;

    if (req.method === 'GET') {
      return handleGet(req, res, tenantId);
    } else if (req.method === 'POST') {
      return handlePost(req, res, tenantId);
    } else if (req.method === 'PUT') {
      return handlePut(req, res, tenantId);
    } else if (req.method === 'DELETE') {
      return handleDelete(req, res, tenantId);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[Membership Tiers] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(req, res, tenantId) {
  const { action, configId } = req.query;

  if (action === 'fields') {
    return getAvailableFields(req, res, tenantId);
  }

  if (action === 'discount_fields') {
    return getDiscountFields(req, res, tenantId);
  }

  if (action === 'structure_fields') {
    return getStructureFields(req, res, tenantId);
  }

  if (action === 'invoice_address_fields') {
    return getInvoiceAddressFields(req, res, tenantId);
  }

  if (action === 'preview') {
    return getPreview(req, res, tenantId, configId);
  }

  if (action === 'history') {
    return getHistory(req, res, tenantId);
  }

  if (configId) {
    return getConfigById(req, res, tenantId, configId);
  }

  const { data: allTenantConfigs } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('effective_from', { ascending: false, nullsFirst: true });

  const all = allTenantConfigs || [];
  // Explicit lambda: Array.filter passes the element index as the second
  // argument, which isConfigInEffect would treat as its onDate string —
  // silently dropping every dated config from the "in effect" list.
  const configs = all.filter(c => isConfigInEffect(c));
  const firstConfig = configs[0] || all[0] || null;

  let bands = [];
  let discounts = [];
  let vatOverrides = [];
  let reminders = [];
  if (firstConfig) {
    bands = await getBandsForConfig(firstConfig.id, tenantId);
    discounts = await getDiscountsForConfig(firstConfig.id, tenantId);
    vatOverrides = await getVatOverridesForConfig(firstConfig.id, tenantId);
    reminders = await getRemindersForConfig(firstConfig.id, tenantId);
  }

  const history = all.map(c => ({
    id: c.id,
    name: c.name,
    effective_from: c.effective_from,
    effective_to: c.effective_to,
    created_at: c.created_at,
    structure_scope_type: c.structure_scope_type,
    structure_field_id: c.structure_field_id,
    structure_field_name: c.structure_field_name,
    structure_match_value: c.structure_match_value,
    status: configLifecycleStatus(c)
  }));

  return res.json({
    config: firstConfig,
    bands,
    discounts,
    vatOverrides,
    reminders,
    activeConfigs: configs,
    history
  });
}

async function getCurrentConfig(tenantId) {
  const onDate = todayStr();
  const { data: rows, error } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .or(`effective_from.is.null,effective_from.lte.${onDate}`)
    .or(`effective_to.is.null,effective_to.gte.${onDate}`)
    .order('effective_from', { ascending: false, nullsFirst: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[Membership Tiers] Error fetching current config:', error);
    return null;
  }
  return rows;
}

async function getBandsForConfig(configId, tenantId) {
  const { data: bandsData, error } = await supabase
    .from('membership_tier_band')
    .select('*')
    .eq('config_id', configId)
    .eq('tenant_id', tenantId)
    .order('display_order', { ascending: true, nullsFirst: false })
    .order('min_value', { ascending: true, nullsFirst: false });

  if (error) {
    console.error('[Membership Tiers] Error fetching bands:', error);
    return [];
  }
  return bandsData || [];
}

async function getConfigById(req, res, tenantId, configId) {
  const { data: config, error: configError } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('id', configId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (configError || !config) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  const bands = await getBandsForConfig(config.id, tenantId);
  const discounts = await getDiscountsForConfig(config.id, tenantId);
  const vatOverrides = await getVatOverridesForConfig(config.id, tenantId);
  const reminders = await getRemindersForConfig(config.id, tenantId);

  return res.json({
    config,
    bands,
    discounts,
    vatOverrides,
    reminders,
    isHistorical: config.effective_to !== null
  });
}

async function getHistory(req, res, tenantId) {
  const { data: configs, error } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('effective_from', { ascending: false, nullsFirst: true });

  if (error) {
    console.error('[Membership Tiers] Error fetching history:', error);
    return res.status(500).json({ error: 'Failed to fetch history' });
  }

  const results = [];
  for (const config of (configs || [])) {
    const bands = await getBandsForConfig(config.id, tenantId);
    const discounts = await getDiscountsForConfig(config.id, tenantId);
    const vatOverrides = await getVatOverridesForConfig(config.id, tenantId);
    results.push({
      config,
      bands,
      discounts,
      vatOverrides,
      isHistorical: config.effective_to !== null,
      status: configLifecycleStatus(config)
    });
  }

  return res.json(results);
}

async function getAvailableFields(req, res, tenantId) {
  const { data: fields, error } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type, entity_scope, options')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) {
    console.error('[Membership Tiers] Error fetching fields:', error);
    return res.status(500).json({ error: 'Failed to fetch fields' });
  }

  const usableFields = (fields || []).filter(f =>
    isNumericFieldType(f.field_type) || isTextFieldType(f.field_type)
  );

  const coreFields = [
    { id: 'core:member_count', name: 'member_count', label: 'Member Count', field_type: 'number', entity_scope: 'organization', is_core: true }
  ];

  return res.json([...coreFields, ...usableFields]);
}

async function getPreview(req, res, tenantId, configId) {
  let config;

  if (configId) {
    const { data, error } = await supabase
      .from('membership_tier_config')
      .select('*')
      .eq('id', configId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error || !data) {
      return res.json({ organizations: [], members: [], unmapped: [] });
    }
    config = data;
  } else {
    config = await getCurrentConfig(tenantId);
    if (!config) {
      return res.json({ organizations: [], members: [], unmapped: [] });
    }
  }

  const scopeType = config.structure_scope_type || 'organization';

  if (scopeType === 'member') {
    return getMemberPreview(req, res, tenantId, config);
  }

  const bands = await getBandsForConfig(config.id, tenantId);

  const { data: allOrgs, error: orgError } = await supabase
    .from('organization')
    .select('id, name, status')
    .eq('tenant_id', tenantId)
    .order('name', { ascending: true });

  if (orgError) {
    return res.status(500).json({ error: 'Failed to fetch organizations' });
  }

  let orgs = allOrgs || [];

  if (config.structure_field_id && config.structure_match_value) {
    const allOrgIds = orgs.map(o => o.id);
    const { data: scopeValues } = await supabase
      .from('organization_preference_value')
      .select('organization_id, value')
      .eq('field_id', config.structure_field_id)
      .in('organization_id', allOrgIds.length > 0 ? allOrgIds : ['__none__']);

    const matchingOrgIds = new Set(
      (scopeValues || [])
        .filter(pv => pv.value === config.structure_match_value)
        .map(pv => pv.organization_id)
    );
    orgs = orgs.filter(o => matchingOrgIds.has(o.id));
  }

  const isFlat = config.pricing_model === 'flat';
  const flatCost = isFlat ? parseFloat(config.flat_cost) || 0 : null;

  let orgValues = {};

  if (!isFlat) {
    if (config.field_source === 'core' && config.field_name === 'member_count') {
      const { data: members } = await supabase
        .from('member')
        .select('organization_id')
        .eq('tenant_id', tenantId)
        .not('organization_id', 'is', null);

      const counts = {};
      (members || []).forEach(m => {
        counts[m.organization_id] = (counts[m.organization_id] || 0) + 1;
      });
      orgValues = counts;
    } else if (config.field_id) {
      const orgIds = (orgs || []).map(o => o.id);
      const { data: prefValues } = await supabase
        .from('organization_preference_value')
        .select('organization_id, value')
        .eq('field_id', config.field_id)
        .in('organization_id', orgIds.length > 0 ? orgIds : ['__none__']);

      (prefValues || []).forEach(pv => {
        if (pv.value != null && pv.value !== '') {
          orgValues[pv.organization_id] = pv.value;
        }
      });
    }
  }

  const results = (orgs || []).map(org => {
    if (isFlat) {
      return {
        id: org.id,
        name: org.name,
        status: org.status,
        fieldValue: null,
        tierLabel: 'Flat Rate',
        annualCost: flatCost,
        bandId: 'flat'
      };
    }

    const fieldValue = orgValues[org.id] ?? null;
    const matchedBand = matchBand(fieldValue, bands);

    return {
      id: org.id,
      name: org.name,
      status: org.status,
      fieldValue,
      tierLabel: matchedBand?.label || null,
      annualCost: matchedBand ? parseFloat(matchedBand.annual_cost) : null,
      bandId: matchedBand?.id || null
    };
  });

  const mapped = results.filter(r => r.bandId);
  const unmapped = results.filter(r => !r.bandId);

  return res.json({
    config,
    bands: bands || [],
    organizations: mapped,
    unmapped,
    summary: {
      totalOrgs: results.length,
      mappedOrgs: mapped.length,
      unmappedOrgs: unmapped.length,
      totalAnnualRevenue: mapped.reduce((sum, r) => sum + (r.annualCost || 0), 0)
    }
  });
}

async function getMemberPreview(req, res, tenantId, config) {
  const bands = await getBandsForConfig(config.id, tenantId);

  const { data: allMembers, error: memberError } = await supabase
    .from('member')
    .select('id, first_name, last_name, email, status, organization_id')
    .eq('tenant_id', tenantId)
    .order('last_name', { ascending: true });

  if (memberError) {
    return res.status(500).json({ error: 'Failed to fetch members' });
  }

  let members = (allMembers || []).filter(m => !m.organization_id);

  if (config.structure_field_id && config.structure_match_value) {
    const isCoreField = config.structure_field_id.startsWith('core:');

    if (isCoreField) {
      const coreFieldName = config.structure_field_id.replace('core:', '');
      members = members.filter(m => {
        const val = (m[coreFieldName] || '').toString().toLowerCase().trim();
        const matchVal = config.structure_match_value.toString().toLowerCase().trim();
        return val === matchVal;
      });
    } else {
      const memberIds = members.map(m => m.id);
      if (memberIds.length > 0) {
        const { data: scopeValues } = await supabase
          .from('member_preference_value')
          .select('member_id, value')
          .eq('field_id', config.structure_field_id)
          .in('member_id', memberIds);

        const matchingMemberIds = new Set(
          (scopeValues || [])
            .filter(pv => {
              const val = (pv.value || '').toString().toLowerCase().trim();
              const matchVal = config.structure_match_value.toString().toLowerCase().trim();
              return val === matchVal;
            })
            .map(pv => pv.member_id)
        );
        members = members.filter(m => matchingMemberIds.has(m.id));
      }
    }
  }

  const isFlat = config.pricing_model === 'flat';
  const flatCost = isFlat ? parseFloat(config.flat_cost) || 0 : null;

  let memberValues = {};

  if (!isFlat && config.field_id) {
    const isCoreField = config.field_id.startsWith && config.field_id.startsWith('core:');

    if (config.field_source === 'core' || isCoreField) {
      const coreFieldName = isCoreField ? config.field_id.replace('core:', '') : config.field_name;
      if (coreFieldName) {
        members.forEach(m => {
          const numVal = parseFloat(m[coreFieldName]);
          if (!isNaN(numVal)) {
            memberValues[m.id] = numVal;
          }
        });
      }
    } else {
      const memberIds = members.map(m => m.id);
      if (memberIds.length > 0) {
        const { data: prefValues } = await supabase
          .from('member_preference_value')
          .select('member_id, value')
          .eq('field_id', config.field_id)
          .in('member_id', memberIds);

        (prefValues || []).forEach(pv => {
          if (pv.value != null && pv.value !== '') {
            memberValues[pv.member_id] = pv.value;
          }
        });
      }
    }
  }

  const results = members.map(member => {
    const name = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email || 'Unknown';

    if (isFlat) {
      return {
        id: member.id,
        name,
        email: member.email,
        status: member.status,
        fieldValue: null,
        tierLabel: 'Flat Rate',
        annualCost: flatCost,
        bandId: 'flat'
      };
    }

    const fieldValue = memberValues[member.id] ?? null;
    const matchedBand = matchBand(fieldValue, bands);

    return {
      id: member.id,
      name,
      email: member.email,
      status: member.status,
      fieldValue,
      tierLabel: matchedBand?.label || null,
      annualCost: matchedBand ? parseFloat(matchedBand.annual_cost) : null,
      bandId: matchedBand?.id || null
    };
  });

  const mapped = results.filter(r => r.bandId);
  const unmapped = results.filter(r => !r.bandId);

  return res.json({
    config,
    bands: bands || [],
    members: mapped,
    unmapped,
    summary: {
      totalMembers: results.length,
      mappedMembers: mapped.length,
      unmappedMembers: unmapped.length,
      totalAnnualRevenue: mapped.reduce((sum, r) => sum + (r.annualCost || 0), 0)
    }
  });
}

function parseFieldOptions(raw) {
  if (!raw) return [];
  try {
    const opts = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(opts)) return [];
    return opts.map(o => {
      if (typeof o === 'string') return o;
      return o.value ?? o.label ?? '';
    }).filter(v => v !== '' && v != null).map(v => String(v));
  } catch {
    return [];
  }
}

function validateBands(bands, basisField) {
  if (!bands || !Array.isArray(bands) || bands.length === 0) return null;

  const isTextBasis = basisField
    ? isTextFieldType(basisField.field_type)
    : bands.some(b => b && b.match_value != null && String(b.match_value).trim() !== '');

  if (isTextBasis) {
    const allowedOptions = basisField ? parseFieldOptions(basisField.options) : [];
    const allowedNormalized = new Set(allowedOptions.map(o => normalizeMatchValue(o)));
    const seen = new Set();
    for (let i = 0; i < bands.length; i++) {
      const band = bands[i];
      const hasNumeric =
        (band.min_value !== null && band.min_value !== undefined && band.min_value !== '') ||
        (band.max_value !== null && band.max_value !== undefined && band.max_value !== '');
      if (hasNumeric) {
        return { error: `Tier "${band.label || i + 1}" mixes numeric min/max with a text-basis field. Remove the numeric range.` };
      }
      const raw = band.match_value != null ? String(band.match_value).trim() : '';
      if (!raw) {
        return { error: `Tier "${band.label || i + 1}" needs a match value` };
      }
      const norm = normalizeMatchValue(raw);
      if (seen.has(norm)) {
        return { error: `Tier "${band.label || i + 1}" has a duplicate match value "${raw}"` };
      }
      seen.add(norm);
      if (allowedNormalized.size > 0 && !allowedNormalized.has(norm)) {
        return { error: `Tier "${band.label || i + 1}" has match value "${raw}" which is not one of the allowed options (${allowedOptions.join(', ')})` };
      }
      if (isNaN(parseFloat(band.annual_cost))) {
        return { error: `Tier "${band.label || i + 1}" has an invalid cost` };
      }
    }
    return { sortedBands: bands.map((b, i) => ({ ...b, min_value: null, max_value: null, match_value: String(b.match_value).trim(), display_order: i })) };
  }

  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    if (band.match_value != null && String(band.match_value).trim() !== '') {
      return { error: `Tier "${band.label || i + 1}" has a text match value but the selected field is numeric. Remove the match value.` };
    }
  }

  const sortedBands = [...bands].sort((a, b) => (parseFloat(a.min_value) || 0) - (parseFloat(b.min_value) || 0));
  for (let i = 0; i < sortedBands.length; i++) {
    const band = sortedBands[i];
    const min = parseFloat(band.min_value);
    const max = band.max_value !== null && band.max_value !== undefined && band.max_value !== '' ? parseFloat(band.max_value) : null;

    if (isNaN(min)) {
      return { error: `Tier "${band.label || i + 1}" has an invalid minimum value` };
    }
    if (max !== null && isNaN(max)) {
      return { error: `Tier "${band.label || i + 1}" has an invalid maximum value` };
    }
    if (max !== null && max < min) {
      return { error: `Tier "${band.label || i + 1}" has max value less than min value` };
    }

    if (i > 0) {
      const prevBand = sortedBands[i - 1];
      const prevMax = prevBand.max_value !== null && prevBand.max_value !== undefined && prevBand.max_value !== ''
        ? parseFloat(prevBand.max_value) : null;
      if (prevMax === null) {
        return { error: `Tier "${prevBand.label || i}" has no maximum value (open-ended), so no further tiers can follow it. Set a max value or remove subsequent tiers.` };
      }
      if (min <= prevMax) {
        return { error: `Tier "${band.label || i + 1}" overlaps with the previous tier. Min value (${min}) should be greater than previous max (${prevMax}).` };
      }
    }
  }
  return { sortedBands };
}

async function validateFeeLinkEmailTemplate(tenantId, templateId) {
  if (!templateId) return { ok: true };
  const { data: tpl, error } = await supabase
    .from('email_template')
    .select('id, name, subject, body, is_active')
    .eq('id', templateId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error || !tpl) {
    return { ok: false, error: 'Selected fee-link email template could not be found for this tenant' };
  }
  if (!/\{\{\s*payment_link\s*\}\}/.test(tpl.body || '')) {
    return {
      ok: false,
      field: 'fee_link_email_template_id',
      error: `Fee-link email template "${tpl.name || tpl.subject || tpl.id}" must contain the {{payment_link}} placeholder in its body — without it, the recipient has no way to pay.`,
    };
  }
  return { ok: true };
}

async function validateRenewalPolicy(tenantId, config) {
  const integerDays = (field, fallback) => {
    if (config[field] === undefined || config[field] === null) return { value: fallback };
    if (typeof config[field] !== 'number' || !Number.isInteger(config[field]) || config[field] < 0 || config[field] > 366) {
      return { error: `${field} must be an integer between 0 and 366`, field };
    }
    return { value: config[field] };
  };

  const openDays = integerDays('renewal_open_days', 0);
  if (openDays.error) return openDays;
  const graceDays = integerDays('renewal_grace_days', 0);
  if (graceDays.error) return graceDays;

  for (const field of ['renewal_disable_login', 'renewal_change_role']) {
    if (config[field] !== undefined && config[field] !== null && typeof config[field] !== 'boolean') {
      return { error: `${field} must be a boolean`, field };
    }
  }

  const changeRole = config.renewal_change_role === true;
  let fallbackRoleId = null;
  if (changeRole) {
    if (typeof config.renewal_fallback_role_id !== 'string' || !config.renewal_fallback_role_id.trim()) {
      return { error: 'A fallback role is required when changing role after renewal', field: 'renewal_fallback_role_id' };
    }
    fallbackRoleId = config.renewal_fallback_role_id.trim();
    const { data: role, error } = await supabase
      .from('role')
      .select('id')
      .eq('id', fallbackRoleId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error || !role) {
      return { error: 'Selected fallback role could not be found for this tenant', field: 'renewal_fallback_role_id' };
    }
  }

  return {
    ok: true,
    fields: {
      renewal_open_days: openDays.value,
      renewal_grace_days: graceDays.value,
      renewal_disable_login: config.renewal_disable_login === true,
      renewal_change_role: changeRole,
      renewal_fallback_role_id: fallbackRoleId,
    },
  };
}

async function handlePost(req, res, tenantId) {
  let { config, bands, discounts, vatOverrides, reminders } = req.body;

  if (!config) {
    return res.status(400).json({ error: 'Configuration is required' });
  }

  if (!config.effective_from) {
    return res.status(400).json({ error: 'Effective from date is required' });
  }

  const renewalPolicy = await validateRenewalPolicy(tenantId, config);
  if (!renewalPolicy.ok) {
    return res.status(400).json({ error: renewalPolicy.error, field: renewalPolicy.field });
  }

  const parsedFlatCost = config.pricing_model === 'flat'
    ? parseFlatMembershipCost(config.flat_cost)
    : null;
  if (parsedFlatCost && !parsedFlatCost.valid) {
    return res.status(400).json({ error: parsedFlatCost.error, field: 'flat_cost' });
  }

  const feeLinkCheck = await validateFeeLinkEmailTemplate(tenantId, config.fee_link_email_template_id);
  if (!feeLinkCheck.ok) {
    return res.status(400).json({ error: feeLinkCheck.error, field: feeLinkCheck.field });
  }

  const normalizedRecipients = normalizeInvoiceRecipients(config.invoice_recipients);
  if ((config.structure_scope_type || 'organization') !== 'member') {
    const recipientErr = validateInvoiceRecipientsShape(normalizedRecipients);
    if (recipientErr) {
      return res.status(400).json({ error: recipientErr });
    }
  }

  if (config.structure_field_id && !config.structure_match_value?.trim()) {
    return res.status(400).json({ error: 'Match value is required when a structure scope field is selected' });
  }

  let basisField = null;
  let resolvedCustomFieldLabel = null;
  if (config.pricing_model !== 'flat' && bands && Array.isArray(bands) && bands.length > 0) {
    if (config.field_source === 'core' || (config.field_name === 'member_count' && !config.field_id)) {
      basisField = { id: null, name: config.field_name || 'member_count', field_type: 'number', options: null, is_core: true };
    } else if (config.field_id) {
      const { data: fld, error: fldErr } = await supabase
        .from('preference_field')
        .select('id, name, label, field_type, options')
        .eq('id', config.field_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (fldErr || !fld) {
        return res.status(400).json({ error: 'Selected basis field could not be resolved for this tenant' });
      }
      if (!isNumericFieldType(fld.field_type) && !isTextFieldType(fld.field_type)) {
        return res.status(400).json({ error: `Selected basis field type "${fld.field_type}" is not supported for tier bands` });
      }
      basisField = fld;
      resolvedCustomFieldLabel = fld.label || fld.name || null;
    } else {
      return res.status(400).json({ error: 'A basis field is required for tiered pricing' });
    }

    const validation = validateBands(bands, basisField);
    if (validation?.error) {
      return res.status(400).json({ error: validation.error });
    }
    bands = validation.sortedBands;
  } else if (config.pricing_model !== 'flat' && config.field_source === 'custom' && config.field_id) {
    const { data: fld } = await supabase
      .from('preference_field')
      .select('id, name, label')
      .eq('id', config.field_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (fld) {
      resolvedCustomFieldLabel = fld.label || fld.name || null;
    }
  }

  function deriveFieldName(rawFieldName) {
    if (config.field_source === 'custom' && config.field_id && resolvedCustomFieldLabel) {
      return resolvedCustomFieldLabel;
    }
    return rawFieldName || null;
  }

  const configId = config.id || req.query.configId;

  if (configId) {
    const { data: existingConfig } = await supabase
      .from('membership_tier_config')
      .select('*')
      .eq('id', configId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!existingConfig) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    if (existingConfig.effective_to !== null) {
      return res.status(400).json({ error: 'Cannot modify a historical tier structure. Create a new one instead.' });
    }

    const { data, error } = await supabase
      .from('membership_tier_config')
      .update({
        name: config.name || 'Default',
        field_source: config.field_source || 'custom',
        field_id: config.field_id || null,
        field_name: deriveFieldName(config.field_name),
        currency: config.currency || 'GBP',
        billing_period: config.billing_period || 'annual',
        is_active: config.is_active !== false,
        effective_from: config.effective_from,
        membership_start_month: config.membership_start_month ?? 1,
        membership_start_day: config.membership_start_day ?? 1,
        start_mode: config.start_mode === 'immediate' ? 'immediate' : 'fixed_date',
        prorata_enabled: config.prorata_enabled ?? false,
        free_period_amount: config.free_period_amount || null,
        free_period_unit: config.free_period_amount ? (config.free_period_unit || 'months') : null,
        rollover_enabled: config.free_period_amount ? (config.rollover_enabled ?? false) : false,
        structure_field_id: config.structure_field_id || null,
        structure_match_value: config.structure_match_value || null,
        structure_scope_type: config.structure_scope_type || 'organization',
        pricing_model: config.pricing_model || 'tiered',
        flat_cost: config.pricing_model === 'flat' ? parsedFlatCost.value : null,
        flat_vat_rate: config.pricing_model === 'flat' ? (config.flat_vat_rate || null) : null,
        invoice_description: config.invoice_description || null,
        auto_approve_fees: config.auto_approve_fees ?? false,
        online_card_payment: config.online_card_payment ?? false,
        invoice_address_field_id: parseInvoiceAddressFieldId(config.invoice_address_field),
        invoice_address_field_name: parseInvoiceAddressFieldName(config.invoice_address_field),
        invoice_recipients: normalizedRecipients,
        fee_link_email_template_id: config.fee_link_email_template_id || null,
        ...renewalPolicy.fields,
        ...(await checkConfigNominalCodeColumnExists()
          ? { nominal_code: config.pricing_model === 'flat' ? normalizeNominalCode(config.nominal_code) : null }
          : {}),
        ...ddConfigFields(config),
        updated_at: new Date().toISOString()
      })
      .eq('id', configId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) {
      console.error('[Membership Tiers] Error updating config:', error);
      return res.status(500).json({ error: 'Failed to update configuration' });
    }

    if (bands && Array.isArray(bands)) {
      await saveBandsForConfig(data.id, tenantId, bands);
    }

    if (discounts && Array.isArray(discounts)) {
      await saveDiscountsForConfig(data.id, tenantId, discounts);
    }

    if (vatOverrides && Array.isArray(vatOverrides)) {
      await saveVatOverridesForConfig(data.id, tenantId, vatOverrides);
    }

    if (reminders && Array.isArray(reminders)) {
      await saveRemindersForConfig(data.id, tenantId, reminders);
    }

    const savedBands = await getBandsForConfig(data.id, tenantId);
    const savedDiscounts = await getDiscountsForConfig(data.id, tenantId);
    const savedVatOverrides = await getVatOverridesForConfig(data.id, tenantId);
    const savedReminders = await getRemindersForConfig(data.id, tenantId);
    return res.json({ config: data, bands: savedBands, discounts: savedDiscounts, vatOverrides: savedVatOverrides, reminders: savedReminders });
  }

  const structureFieldId = config.structure_field_id || null;
  const structureMatchValue = config.structure_match_value || null;
  const onDate = todayStr();

  let scopeQuery = supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId);

  if (structureFieldId) {
    scopeQuery = scopeQuery.eq('structure_field_id', structureFieldId).eq('structure_match_value', structureMatchValue);
  } else {
    scopeQuery = scopeQuery.is('structure_field_id', null);
  }

  const { data: scopeConfigsRaw } = await scopeQuery.order('effective_from', { ascending: false, nullsFirst: true });
  const scopeConfigs = scopeConfigsRaw || [];

  // The structure currently in effect today for this scope. It should remain
  // live until the new structure's start date. It may already be capped by a
  // previously-scheduled future structure.
  const currentConfig = scopeConfigs.find(c => isConfigInEffect(c, onDate)) || null;

  // Any pending future structure(s) already scheduled for this scope. Saving a
  // new future-dated structure replaces these rather than leaving two
  // conflicting open-ended records.
  const pendingFuture = scopeConfigs.filter(c =>
    c.effective_to === null &&
    c.effective_from && c.effective_from > onDate &&
    (!currentConfig || c.id !== currentConfig.id)
  );

  if (currentConfig && currentConfig.effective_from) {
    if (config.effective_from <= currentConfig.effective_from) {
      return res.status(400).json({
        error: `New tier structure must start after the current one (${currentConfig.effective_from}). Please choose a later date.`
      });
    }
  }

  // Remove any previously-scheduled future structure for this scope so we don't
  // leave conflicting pending records.
  for (const pf of pendingFuture) {
    await supabase.from('membership_tier_band').delete().eq('config_id', pf.id).eq('tenant_id', tenantId);
    await deleteDiscountsForConfig(pf.id, tenantId);
    await deleteVatOverridesForConfig(pf.id, tenantId);
    await saveRemindersForConfig(pf.id, tenantId, []);
    await supabase.from('membership_tier_config').delete().eq('id', pf.id).eq('tenant_id', tenantId);
  }

  // Cap the currently-active structure to end the day before the new one
  // starts, so it stays live until the scheduled switch-over.
  let prevEffectiveTo = null;
  if (currentConfig) {
    prevEffectiveTo = currentConfig.effective_to;
    const prevDay = new Date(`${config.effective_from}T00:00:00Z`);
    prevDay.setUTCDate(prevDay.getUTCDate() - 1);
    const closingDate = prevDay.toISOString().split('T')[0];

    const { error: closeError } = await supabase
      .from('membership_tier_config')
      .update({
        effective_to: closingDate,
        updated_at: new Date().toISOString()
      })
      .eq('id', currentConfig.id)
      .eq('tenant_id', tenantId);

    if (closeError) {
      console.error('[Membership Tiers] Error closing previous config:', closeError);
      return res.status(500).json({ error: 'Failed to close previous tier structure' });
    }
  }

  const { data: newConfig, error: createError } = await supabase
    .from('membership_tier_config')
    .insert({
      tenant_id: tenantId,
      name: config.name || 'Default',
      field_source: config.field_source || 'custom',
      field_id: config.field_id || null,
      field_name: deriveFieldName(config.field_name),
      currency: config.currency || 'GBP',
      billing_period: config.billing_period || 'annual',
      is_active: config.is_active !== false,
      effective_from: config.effective_from,
      effective_to: null,
      membership_start_month: config.membership_start_month ?? 1,
      membership_start_day: config.membership_start_day ?? 1,
      start_mode: config.start_mode === 'immediate' ? 'immediate' : 'fixed_date',
      prorata_enabled: config.prorata_enabled ?? false,
      free_period_amount: config.free_period_amount || null,
      free_period_unit: config.free_period_amount ? (config.free_period_unit || 'months') : null,
      rollover_enabled: config.free_period_amount ? (config.rollover_enabled ?? false) : false,
      structure_field_id: structureFieldId,
      structure_match_value: structureMatchValue,
      structure_scope_type: config.structure_scope_type || 'organization',
      pricing_model: config.pricing_model || 'tiered',
      flat_cost: config.pricing_model === 'flat' ? parsedFlatCost.value : null,
      flat_vat_rate: config.pricing_model === 'flat' ? (config.flat_vat_rate || null) : null,
      invoice_description: config.invoice_description || null,
      auto_approve_fees: config.auto_approve_fees ?? false,
      online_card_payment: config.online_card_payment ?? false,
      invoice_address_field_id: parseInvoiceAddressFieldId(config.invoice_address_field),
      invoice_address_field_name: parseInvoiceAddressFieldName(config.invoice_address_field),
      invoice_recipients: normalizedRecipients,
      fee_link_email_template_id: config.fee_link_email_template_id || null,
      ...renewalPolicy.fields,
      ...(await checkConfigNominalCodeColumnExists()
        ? { nominal_code: config.pricing_model === 'flat' ? normalizeNominalCode(config.nominal_code) : null }
        : {}),
      ...ddConfigFields(config),
    })
    .select()
    .single();

  if (createError) {
    console.error('[Membership Tiers] Error creating config:', createError);
    if (currentConfig) {
      await supabase
        .from('membership_tier_config')
        .update({ effective_to: prevEffectiveTo, updated_at: new Date().toISOString() })
        .eq('id', currentConfig.id)
        .eq('tenant_id', tenantId);
    }
    return res.status(500).json({ error: 'Failed to create configuration' });
  }

  if (bands && Array.isArray(bands) && bands.length > 0) {
    await saveBandsForConfig(newConfig.id, tenantId, bands);
  }

  if (discounts && Array.isArray(discounts) && discounts.length > 0) {
    await saveDiscountsForConfig(newConfig.id, tenantId, discounts);
  }

  if (vatOverrides && Array.isArray(vatOverrides) && vatOverrides.length > 0) {
    await saveVatOverridesForConfig(newConfig.id, tenantId, vatOverrides);
  }

  if (reminders && Array.isArray(reminders) && reminders.length > 0) {
    await saveRemindersForConfig(newConfig.id, tenantId, reminders);
  }

  const savedBands = await getBandsForConfig(newConfig.id, tenantId);
  const savedDiscounts = await getDiscountsForConfig(newConfig.id, tenantId);
  const savedVatOverrides = await getVatOverridesForConfig(newConfig.id, tenantId);
  const savedReminders = await getRemindersForConfig(newConfig.id, tenantId);

  const { data: allConfigs } = await supabase
    .from('membership_tier_config')
    .select('id, name, effective_from, effective_to, created_at, structure_field_id, structure_match_value')
    .eq('tenant_id', tenantId)
    .order('effective_from', { ascending: false, nullsFirst: true });

  const history = (allConfigs || []).map(c => ({ ...c, status: configLifecycleStatus(c) }));

  return res.json({
    config: newConfig,
    bands: savedBands,
    discounts: savedDiscounts,
    vatOverrides: savedVatOverrides,
    reminders: savedReminders,
    history
  });
}

// Phase 2 (GoCardless monthly Direct Debit) tier-level settings. Shared by
// the update and insert paths so the whitelists can't drift apart.
function ddConfigFields(config) {
  // Task #3620: monthly card (Stripe) plans share the dd_* amount/instalment/
  // activation/grace settings, so those columns must survive whenever EITHER
  // monthly option is enabled. dd_enabled itself stays strictly DD.
  const cardMonthlyEnabled = config.card_monthly_enabled === true;
  const enabled = config.dd_enabled === true || cardMonthlyEnabled;
  if (!enabled) {
    // Columns from the Phase 2 migration are NOT NULL with defaults, so the
    // disabled path must write those schema defaults (writing null raises
    // 23502). Truly nullable columns stay null so re-enabling starts clean.
    return {
      dd_enabled: false,
      card_monthly_enabled: false,
      dd_instalment_count: 12,
      dd_monthly_amount: null,
      dd_first_collection_rule: 'earliest',
      dd_collection_day: null,
      dd_activation_rule: 'first_payment',
      dd_auto_renew: true,
      dd_grace_days: 7,
      dd_terms_version: null,
      dd_migration_enabled: false,
      dd_invoicing_mode: 'annual',
    };
  }
  const instalments = Math.min(12, Math.max(1, parseInt(config.dd_instalment_count, 10) || 12));
  const rule = ['earliest', 'nominated_day', 'anniversary'].includes(config.dd_first_collection_rule)
    ? config.dd_first_collection_rule : 'earliest';
  const activation = ['mandate', 'first_payment', 'manual'].includes(config.dd_activation_rule)
    ? config.dd_activation_rule : 'first_payment';
  const day = rule === 'nominated_day'
    ? Math.min(28, Math.max(1, parseInt(config.dd_collection_day, 10) || 1))
    : null;
  const monthly = config.pricing_model === 'flat'
    ? (parseFloat(config.dd_monthly_amount) > 0 ? parseFloat(config.dd_monthly_amount) : null)
    : null;
  return {
    dd_enabled: config.dd_enabled === true,
    card_monthly_enabled: cardMonthlyEnabled,
    dd_instalment_count: instalments,
    dd_monthly_amount: monthly,
    dd_first_collection_rule: rule,
    dd_collection_day: day,
    dd_activation_rule: activation,
    dd_auto_renew: config.dd_auto_renew !== false,
    dd_grace_days: Number.isInteger(parseInt(config.dd_grace_days, 10))
      ? Math.max(0, parseInt(config.dd_grace_days, 10)) : 7,
    dd_terms_version: config.dd_terms_version || 'v1',
    dd_migration_enabled: config.dd_migration_enabled === true,
    // Task #3633: 'annual' (single annual invoice, default) or
    // 'per_instalment' (one paid invoice per monthly collection). Applies to
    // both GC DD and Stripe monthly card plans; snapshotted at consent so it
    // only affects newly started plans.
    dd_invoicing_mode: config.dd_invoicing_mode === 'per_instalment' ? 'per_instalment' : 'annual',
  };
}

async function checkDdBandColumnExists() {
  const { error } = await supabase
    .from('membership_tier_band')
    .select('dd_monthly_amount')
    .limit(0);
  return !error;
}

async function checkVatRateColumnExists() {
  const { data, error } = await supabase
    .from('membership_tier_band')
    .select('vat_rate')
    .limit(0);
  return !error;
}

async function checkBandNominalCodeColumnExists() {
  const { error } = await supabase
    .from('membership_tier_band')
    .select('nominal_code')
    .limit(0);
  return !error;
}

async function checkConfigNominalCodeColumnExists() {
  const { error } = await supabase
    .from('membership_tier_config')
    .select('nominal_code')
    .limit(0);
  return !error;
}

function normalizeNominalCode(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function checkMatchValueColumnExists() {
  const { data, error } = await supabase
    .from('membership_tier_band')
    .select('match_value')
    .limit(0);
  return !error;
}

async function saveBandsForConfig(configId, tenantId, bands) {
  if (bands.length === 0) {
    const { error: deleteError } = await supabase
      .from('membership_tier_band')
      .delete()
      .eq('config_id', configId)
      .eq('tenant_id', tenantId);
    if (deleteError) {
      console.error('[Membership Tiers] Error clearing bands:', deleteError);
    }
    return;
  }

  const hasVatColumn = await checkVatRateColumnExists();
  const hasMatchValueColumn = await checkMatchValueColumnExists();
  const hasDdColumn = await checkDdBandColumnExists();
  const hasNominalColumn = await checkBandNominalCodeColumnExists();

  const bandsToInsert = bands.map((band, index) => {
    const hasMatchValue = band.match_value != null && String(band.match_value).trim() !== '';
    const row = {
      config_id: configId,
      tenant_id: tenantId,
      label: band.label || `Tier ${index + 1}`,
      min_value: hasMatchValue ? null : (band.min_value ?? 0),
      max_value: hasMatchValue ? null : (band.max_value ?? null),
      annual_cost: band.annual_cost ?? 0,
      display_order: index,
    };
    if (hasVatColumn) {
      row.vat_rate = band.vat_rate || null;
    }
    if (hasNominalColumn) {
      row.nominal_code = normalizeNominalCode(band.nominal_code);
    }
    if (hasMatchValueColumn) {
      row.match_value = hasMatchValue ? String(band.match_value).trim() : null;
    }
    if (hasDdColumn) {
      const dd = parseFloat(band.dd_monthly_amount);
      row.dd_monthly_amount = Number.isFinite(dd) && dd > 0 ? dd : null;
    }
    return row;
  });

  const { error: deleteError } = await supabase
    .from('membership_tier_band')
    .delete()
    .eq('config_id', configId)
    .eq('tenant_id', tenantId);

  if (deleteError) {
    console.error('[Membership Tiers] Error clearing bands:', deleteError);
  }

  const { error: insertError } = await supabase
    .from('membership_tier_band')
    .insert(bandsToInsert);

  if (insertError) {
    console.error('[Membership Tiers] Error inserting bands:', insertError);
  }
}

async function handlePut(req, res, tenantId) {
  return handlePost(req, res, tenantId);
}

async function handleDelete(req, res, tenantId) {
  const { bandId, configId } = req.query;

  if (bandId) {
    const { error } = await supabase
      .from('membership_tier_band')
      .delete()
      .eq('id', bandId)
      .eq('tenant_id', tenantId);

    if (error) {
      console.error('[Membership Tiers] Error deleting band:', error);
      return res.status(500).json({ error: 'Failed to delete band' });
    }
    return res.json({ success: true });
  }

  if (configId) {
    const { data: config } = await supabase
      .from('membership_tier_config')
      .select('id, effective_to')
      .eq('id', configId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!config) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    await supabase
      .from('membership_tier_band')
      .delete()
      .eq('config_id', config.id)
      .eq('tenant_id', tenantId);

    await deleteDiscountsForConfig(config.id, tenantId);

    await supabase
      .from('membership_tier_config')
      .delete()
      .eq('id', config.id)
      .eq('tenant_id', tenantId);

    if (config.effective_to === null) {
      const { data: prevConfig } = await supabase
        .from('membership_tier_config')
        .select('id')
        .eq('tenant_id', tenantId)
        .not('id', 'eq', config.id)
        .order('effective_from', { ascending: false, nullsFirst: true })
        .limit(1)
        .maybeSingle();

      if (prevConfig) {
        await supabase
          .from('membership_tier_config')
          .update({ effective_to: null, updated_at: new Date().toISOString() })
          .eq('id', prevConfig.id)
          .eq('tenant_id', tenantId);
      }
    }

    return res.json({ success: true });
  }

  const config = await getCurrentConfig(tenantId);

  if (config) {
    await supabase
      .from('membership_tier_band')
      .delete()
      .eq('config_id', config.id);

    await supabase
      .from('membership_tier_config')
      .delete()
      .eq('id', config.id)
      .eq('tenant_id', tenantId);
  }

  return res.json({ success: true });
}

async function getDiscountsForConfig(configId, tenantId) {
  try {
    const { data, error } = await supabase
      .from('membership_tier_discount')
      .select('*')
      .eq('config_id', configId)
      .eq('tenant_id', tenantId)
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('[Membership Tiers] Error fetching discounts:', error);
      return [];
    }
    return data || [];
  } catch {
    return [];
  }
}

async function saveDiscountsForConfig(configId, tenantId, discounts) {
  try {
    await deleteDiscountsForConfig(configId, tenantId);

    if (!discounts || discounts.length === 0) return;

    const rows = discounts.map((d, index) => ({
      config_id: configId,
      tenant_id: tenantId,
      field_id: d.field_id,
      field_label: d.field_label || null,
      match_value: d.match_value || '',
      match_condition: d.match_condition || 'equals',
      discount_type: d.discount_type || 'percentage',
      discount_value: parseFloat(d.discount_value) || 0,
      label: d.label || null,
      sort_order: index,
    }));

    const { error } = await supabase
      .from('membership_tier_discount')
      .insert(rows);

    if (error) {
      console.error('[Membership Tiers] Error saving discounts:', error);
    }
  } catch (err) {
    console.error('[Membership Tiers] Error saving discounts:', err);
  }
}

async function deleteDiscountsForConfig(configId, tenantId) {
  try {
    await supabase
      .from('membership_tier_discount')
      .delete()
      .eq('config_id', configId)
      .eq('tenant_id', tenantId);
  } catch {}
}

async function getStructureFields(req, res, tenantId) {
  const scopeType = req.query.scope_type || 'organization';

  if (scopeType === 'member') {
    const coreFields = [
      { id: 'core:job_title', name: 'job_title', label: 'Job Title', field_type: 'text', entity_scope: 'member', options: null, is_core: true },
      { id: 'core:status', name: 'status', label: 'Status', field_type: 'picklist', entity_scope: 'member', options: ['Active', 'Inactive', 'Pending'], is_core: true },
    ];

    const { data: customFields, error } = await supabase
      .from('preference_field')
      .select('id, name, label, field_type, entity_scope, options')
      .eq('tenant_id', tenantId)
      .eq('entity_scope', 'member')
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (error) {
      console.error('[Membership Tiers] Error fetching member structure fields:', error);
      return res.status(500).json({ error: 'Failed to fetch fields' });
    }

    return res.json([...coreFields, ...(customFields || [])]);
  }

  const { data: fields, error } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type, entity_scope, options')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) {
    console.error('[Membership Tiers] Error fetching structure fields:', error);
    return res.status(500).json({ error: 'Failed to fetch fields' });
  }

  return res.json(fields || []);
}

async function getDiscountFields(req, res, tenantId) {
  const scopeType = req.query.scope_type === 'member' ? 'member' : 'organization';
  const { data: fields, error } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type, entity_scope, options, all_countries, selected_countries')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', scopeType)
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) {
    console.error('[Membership Tiers] Error fetching discount fields:', error);
    return res.status(500).json({ error: 'Failed to fetch fields' });
  }

  return res.json(fields || []);
}

async function getVatOverridesForConfig(configId, tenantId) {
  try {
    const { data, error } = await supabase
      .from('membership_tier_vat_override')
      .select('*')
      .eq('config_id', configId)
      .eq('tenant_id', tenantId)
      .order('sort_order', { ascending: true });

    if (error) {
      if (error.code === '42P01') return [];
      console.error('[Membership Tiers] Error fetching VAT overrides:', error);
      return [];
    }
    return data || [];
  } catch {
    return [];
  }
}

async function saveVatOverridesForConfig(configId, tenantId, vatOverrides) {
  try {
    await deleteVatOverridesForConfig(configId, tenantId);

    if (!vatOverrides || vatOverrides.length === 0) return;

    const rows = vatOverrides.map((d, index) => ({
      config_id: configId,
      tenant_id: tenantId,
      field_id: d.field_id,
      field_label: d.field_label || null,
      match_value: d.match_value || '',
      match_condition: d.match_condition || 'equals',
      vat_rate: d.vat_rate || null,
      label: d.label || null,
      sort_order: index,
    }));

    const { error } = await supabase
      .from('membership_tier_vat_override')
      .insert(rows);

    if (error) {
      console.error('[Membership Tiers] Error saving VAT overrides:', error);
    }
  } catch (err) {
    console.error('[Membership Tiers] Error saving VAT overrides:', err);
  }
}

async function deleteVatOverridesForConfig(configId, tenantId) {
  try {
    await supabase
      .from('membership_tier_vat_override')
      .delete()
      .eq('config_id', configId)
      .eq('tenant_id', tenantId);
  } catch {}
}

function parseInvoiceAddressFieldId(value) {
  if (!value || value === '__default') return null;
  if (typeof value === 'string' && value.startsWith('core:')) return null;
  return value;
}

function parseInvoiceAddressFieldName(value) {
  if (!value || value === '__default') return null;
  if (typeof value === 'string' && value.startsWith('core:')) return value.replace('core:', '');
  return null;
}

async function getInvoiceAddressFields(req, res, tenantId) {
  const scopeType = req.query.scope_type || 'organization';
  const textTypes = ['text', 'textarea', 'long_text'];

  const coreFields = [];
  if (scopeType === 'organization') {
    coreFields.push({
      id: 'core:invoicing_address',
      name: 'invoicing_address',
      label: 'Invoicing Address',
      field_type: 'text',
      entity_scope: 'organization',
      is_core: true,
    });
  }

  const { data: customFields, error } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type, entity_scope')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', scopeType === 'member' ? 'member' : 'organization')
    .eq('is_active', true)
    .in('field_type', textTypes)
    .order('display_order', { ascending: true });

  if (error) {
    console.error('[Membership Tiers] Error fetching invoice address fields:', error);
    return res.status(500).json({ error: 'Failed to fetch fields' });
  }

  return res.json([...coreFields, ...(customFields || [])]);
}
