/**
 * Admin country data-quality report (task: surface unrecognised countries).
 *
 * GET -> scans every stored country value the dashboard's country
 * resolver would see — the organisation `country` system column plus all
 * active `country`/`countries`-typed preference fields on organisations
 * and members — and returns the values that fail resolveCountryToIso2,
 * grouped per distinct value with the records they belong to.
 *
 * Why: a value that doesn't resolve (typo like "Untied Kingdom", or an
 * unmapped publication-style name) is invisible to BOTH the LMIC and
 * NOT-LMIC widgets — the org silently drops out of both breakdowns with
 * no error. This report lets admins fix the stored value or ask for the
 * alias list to be extended.
 *
 * Auth mirrors api/admin/settings/lmic-countries.js (owner/admin +
 * role-exclusion on the same `system.lmic-countries` resource — the
 * report renders on that settings page).
 */

import { getSessionTenantUser } from '../../_lib/session.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { supabase } from '../../_lib/database.js';
import { isResourceExcluded } from '../../_lib/roleVisibility.js';
import { tenantFilter } from '../../dashboard/_lib/permissions.js';
import { getSourceDef, getCustomFieldsForSource } from '../../dashboard/_lib/sources.js';
import { loadPreferenceValues } from '../../dashboard/_lib/aggregation.js';
import { collectUnresolvedCountryValues } from '../../dashboard/_lib/countryDataQuality.js';

const LMIC_RESOURCE_ID = 'system.lmic-countries';
const PAGE_SIZE = 1000;
// Same protective ceiling the widget engine uses: refuse pathological
// scans rather than timing out the function.
const MAX_ROWS_PER_SOURCE = 50000;

async function getRoleExcludedFeatures(roleId) {
  if (!roleId || !supabase) return [];
  try {
    const { data: role } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', roleId)
      .single();
    return role?.excluded_features || [];
  } catch {
    return [];
  }
}

async function loadAllRows(table, columns, tenantId) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    // Stable ordering on id is required for .range() paging (PostgREST
    // silently skips/repeats rows without it).
    const base = supabase
      .from(table)
      .select(columns)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    const { data, error } = await tenantFilter(base, tenantId);
    if (error) {
      const err = new Error(`Failed to load ${table}: ${error.message}`);
      err.pgCode = error.code;
      throw err;
    }
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
    if (rows.length >= MAX_ROWS_PER_SOURCE) {
      throw new Error(`Too many ${table} rows to scan (limit ${MAX_ROWS_PER_SOURCE})`);
    }
  }
  return rows;
}

async function scanSource(sourceId, tenantId, entries) {
  const source = getSourceDef(sourceId);
  const countryFields = (await getCustomFieldsForSource(source, tenantId))
    .filter(f => f.fieldType === 'country' || f.fieldType === 'countries');
  const isOrg = sourceId === 'organization';
  const labelCol = isOrg ? 'name' : 'email';
  let systemCountry = (source.systemFields || []).some(f => f.isCountry && f.name === 'country');
  if (!systemCountry && countryFields.length === 0) return 0;

  let rows;
  try {
    rows = await loadAllRows(
      source.table,
      systemCountry ? `id, ${labelCol}, country` : `id, ${labelCol}`,
      tenantId,
    );
  } catch (err) {
    // The sources registry exposes organization.country, but not every
    // deployment's schema actually has the column (42703 = undefined
    // column). Drop it and rescan on custom fields only rather than
    // failing the whole report.
    if (!systemCountry || err.pgCode !== '42703') throw err;
    systemCountry = false;
    if (countryFields.length === 0) return 0;
    rows = await loadAllRows(source.table, `id, ${labelCol}`, tenantId);
  }

  const prefMap = countryFields.length > 0
    ? await loadPreferenceValues({
        table: source.preferenceTable,
        fkColumn: source.preferenceFkColumn,
        ids: rows.map(r => r.id),
        fieldIds: countryFields.map(f => f.id),
      })
    : new Map();

  for (const row of rows) {
    const record = { id: row.id, label: row[labelCol] || row.id };
    if (systemCountry) {
      entries.push({
        source: sourceId,
        fieldKey: 'system:country',
        fieldLabel: `${source.label} · Country`,
        record,
        value: row.country,
      });
    }
    const prefs = prefMap.get(row.id) || {};
    for (const field of countryFields) {
      entries.push({
        source: sourceId,
        fieldKey: `custom:${field.id}`,
        fieldLabel: `${source.label} · ${field.label}`,
        record,
        value: prefs[field.id],
      });
    }
  }
  return rows.length;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) return res.status(401).json({ error: 'Unauthorized' });
  const tenantId = tenantUser.tenant_id;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context missing' });

  const role = tenantUser.role;
  if (role !== 'owner' && role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  const ctx = await getTenantContext(req);
  const excluded = await getRoleExcludedFeatures(ctx?.roleId);
  if (isResourceExcluded(excluded, LMIC_RESOURCE_ID)) {
    return res.status(403).json({ error: 'Access to LMIC settings has been disabled for your role' });
  }

  try {
    const entries = [];
    const scannedOrganizations = await scanSource('organization', tenantId, entries);
    const scannedMembers = await scanSource('member', tenantId, entries);
    const issues = collectUnresolvedCountryValues(entries);
    return res.json({
      issues,
      scannedOrganizations,
      scannedMembers,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Admin Country DQ] Failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to build country data-quality report' });
  }
}
