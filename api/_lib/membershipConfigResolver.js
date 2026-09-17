import { supabase } from './database.js';

// A renewal stays in the purchased structure's scope; changing a member's
// preferences or a cron's execution date must not move an existing commitment.
export async function resolveRollingSuccessorConfig(client, { tenantId, previousTerm }) {
  const snapshot = previousTerm?.commitment_snapshot;
  const priorConfig = snapshot?.config;
  const boundary = previousTerm?.membership_renewal_date;
  if (!priorConfig || !boundary) throw new Error('Rolling membership requires review: trusted commitment configuration and renewal date are missing.');
  const { data, error } = await client.from('membership_tier_config')
    .select('*').eq('tenant_id', tenantId)
    .or(`effective_from.is.null,effective_from.lte.${boundary}`)
    .or(`effective_to.is.null,effective_to.gte.${boundary}`);
  if (error) throw new Error(`Could not resolve rolling renewal configuration: ${error.message}`);
  const normalize = (value) => String(value ?? '').trim().toLowerCase();
  const matches = (data || []).filter((config) =>
    config.is_active !== false
    && config.start_mode === 'immediate'
    && (config.structure_scope_type || 'organization') === (priorConfig.structure_scope_type || 'organization')
    && normalize(config.structure_field_id) === normalize(priorConfig.structure_field_id)
    && normalize(config.structure_match_value) === normalize(priorConfig.structure_match_value));
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? `Rolling renewal on ${boundary} has overlapping eligible structures; review the effective dates.`
      : `No eligible membership structure exists for rolling renewal on ${boundary}; review the structure effective dates.`);
  }
  return matches[0];
}

function membershipYearValue(value) {
  const match = String(value ?? '').trim().match(/^(-?\d+)/);
  if (!match) return Number.NEGATIVE_INFINITY;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function timestampValue(value) {
  if (value === null || value === undefined || value === '') {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * Return paid annual history rows in newest-year order. These rows are only
 * snapshots; callers must still verify the recorded year and config scope
 * before displaying one as the current paid membership.
 */
export function findHistoricalMemberConfigs(historyRecords = []) {
  return (Array.isArray(historyRecords) ? historyRecords : [])
    .filter((record) => (
      record
      && record.config_id
      && record.payment_status === 'paid'
      && record.billing_period === 'annual'
    ))
    .sort((left, right) => {
      const yearDifference = membershipYearValue(right.membership_year)
        - membershipYearValue(left.membership_year);
      if (yearDifference !== 0) return yearDifference;
      const createdDifference = timestampValue(right.created_at)
        - timestampValue(left.created_at);
      if (createdDifference !== 0) return createdDifference;
      return String(right.id ?? '').localeCompare(String(left.id ?? ''));
    });
}

export async function getAllActiveConfigs(tenantId, onDate = null) {
  const asOf = onDate || new Date().toISOString().split('T')[0];
  const { data, error } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .or(`effective_from.is.null,effective_from.lte.${asOf}`)
    .or(`effective_to.is.null,effective_to.gte.${asOf}`)
    .order('effective_from', { ascending: false, nullsFirst: true });

  if (error) {
    console.error('[membershipConfigResolver] Error fetching active configs:', error);
    return [];
  }
  return data || [];
}

// The member summary endpoint uses this opt-in strict variant so a database
// read failure cannot be mistaken for "no configs" and promote a historical
// paid snapshot. Existing callers intentionally keep the tolerant behavior
// above.
export async function getAllActiveConfigsStrict(tenantId, onDate = null) {
  const asOf = onDate || new Date().toISOString().split('T')[0];
  const { data, error } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .or(`effective_from.is.null,effective_from.lte.${asOf}`)
    .or(`effective_to.is.null,effective_to.gte.${asOf}`)
    .order('effective_from', { ascending: false, nullsFirst: true });
  if (error) throw error;
  return data || [];
}

export async function getConfigForOrganisation(tenantId, organisationId, fieldOverrides = {}, onDate = null) {
  const allConfigs = await getAllActiveConfigs(tenantId, onDate);
  if (!allConfigs || allConfigs.length === 0) return null;

  const configs = allConfigs.filter(c => (c.structure_scope_type || 'organization') === 'organization');
  if (configs.length === 0) return null;

  const unscoped = configs.filter(c => !c.structure_field_id);
  const scoped = configs.filter(c => c.structure_field_id && c.structure_match_value);

  if (scoped.length === 0) {
    return unscoped[0] || null;
  }

  const fieldIds = [...new Set(scoped.map(c => c.structure_field_id))];

  const orgFieldMap = {};
  Object.entries(fieldOverrides).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      orgFieldMap[k] = String(v).toLowerCase().trim();
    }
  });

  const dbFieldIds = fieldIds.filter(id => !(id in fieldOverrides));
  if (dbFieldIds.length > 0) {
    const { data: prefValues } = await supabase
      .from('organization_preference_value')
      .select('field_id, value')
      .eq('organization_id', organisationId)
      .in('field_id', dbFieldIds);

    (prefValues || []).forEach(pv => {
      orgFieldMap[pv.field_id] = (pv.value || '').toString().toLowerCase().trim();
    });
  }

  for (const cfg of scoped) {
    const orgVal = orgFieldMap[cfg.structure_field_id] || '';
    const matchVal = (cfg.structure_match_value || '').toString().toLowerCase().trim();
    if (orgVal && matchVal && orgVal === matchVal) {
      return cfg;
    }
  }

  return unscoped[0] || null;
}

function fallbackFieldLabel(config) {
  if (!config) return 'Value';
  if (config.field_source === 'core' && config.field_name === 'member_count') return 'Member Count';
  return config.field_name || 'Value';
}

export async function resolveBasisFieldLabel(config, tenantId) {
  if (!config) return 'Value';
  if (config.field_source === 'custom' && config.field_id) {
    try {
      const { data } = await supabase
        .from('preference_field')
        .select('label, name')
        .eq('id', config.field_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (data) return data.label || data.name || fallbackFieldLabel(config);
    } catch (err) {
      console.warn('[membershipConfigResolver] resolveBasisFieldLabel error:', err.message);
    }
  }
  return fallbackFieldLabel(config);
}

export async function resolveBasisFieldLabels(configs, tenantId) {
  const labels = new Map();
  const fieldIds = [];
  for (const config of configs || []) {
    if (config?.field_source === 'custom' && config?.field_id) {
      fieldIds.push(config.field_id);
    }
  }
  const uniqueFieldIds = [...new Set(fieldIds)];
  const fieldMap = new Map();
  if (uniqueFieldIds.length > 0) {
    try {
      const { data } = await supabase
        .from('preference_field')
        .select('id, label, name')
        .eq('tenant_id', tenantId)
        .in('id', uniqueFieldIds);
      (data || []).forEach(f => {
        fieldMap.set(f.id, f.label || f.name);
      });
    } catch (err) {
      console.warn('[membershipConfigResolver] resolveBasisFieldLabels error:', err.message);
    }
  }
  for (const config of configs || []) {
    if (!config?.id) continue;
    if (config.field_source === 'custom' && config.field_id && fieldMap.has(config.field_id)) {
      labels.set(config.id, fieldMap.get(config.field_id) || fallbackFieldLabel(config));
    } else {
      labels.set(config.id, fallbackFieldLabel(config));
    }
  }
  return labels;
}

export async function getConfigByIdDirect(tenantId, configId) {
  const { data } = await supabase
    .from('membership_tier_config')
    .select('*')
    .eq('id', configId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return data;
}

export async function getConfigForMember(tenantId, memberId, fieldOverrides = {}, onDate = null) {
  const allConfigs = await getAllActiveConfigs(tenantId, onDate);
  if (!allConfigs || allConfigs.length === 0) return null;

  const configs = allConfigs.filter(c => c.structure_scope_type === 'member');
  if (configs.length === 0) return null;

  const unscoped = configs.filter(c => !c.structure_field_id);
  const scoped = configs.filter(c => c.structure_field_id && c.structure_match_value);

  if (scoped.length === 0) {
    return unscoped[0] || null;
  }

  const coreFieldIds = scoped
    .filter(c => c.structure_field_id.startsWith('core:'))
    .map(c => c.structure_field_id.replace('core:', ''));

  const customFieldIds = scoped
    .filter(c => !c.structure_field_id.startsWith('core:'))
    .map(c => c.structure_field_id);

  const memberFieldMap = {};
  Object.entries(fieldOverrides).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      memberFieldMap[k] = String(v).toLowerCase().trim();
    }
  });

  const unresolvedCoreFields = coreFieldIds.filter(col => !(`core:${col}` in fieldOverrides));
  if (unresolvedCoreFields.length > 0) {
    const selectCols = ['id', ...unresolvedCoreFields].join(', ');
    const { data: member } = await supabase
      .from('member')
      .select(selectCols)
      .eq('id', memberId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (member) {
      for (const col of unresolvedCoreFields) {
        memberFieldMap[`core:${col}`] = (member[col] || '').toString().toLowerCase().trim();
      }
    }
  }

  const unresolvedCustomIds = customFieldIds.filter(id => !(id in fieldOverrides));
  if (unresolvedCustomIds.length > 0) {
    const { data: prefValues } = await supabase
      .from('member_preference_value')
      .select('field_id, value')
      .eq('member_id', memberId)
      .in('field_id', unresolvedCustomIds);

    (prefValues || []).forEach(pv => {
      memberFieldMap[pv.field_id] = (pv.value || '').toString().toLowerCase().trim();
    });
  }

  for (const cfg of scoped) {
    const memberVal = memberFieldMap[cfg.structure_field_id] || '';
    const matchVal = (cfg.structure_match_value || '').toString().toLowerCase().trim();
    if (memberVal && matchVal && memberVal === matchVal) {
      return cfg;
    }
  }

  return unscoped[0] || null;
}
