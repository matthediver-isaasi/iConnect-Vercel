import {
  DEFAULT_SALES_SETTINGS,
  SALES_SEQUENCE_KINDS,
  mapSalesSettingsRow,
} from '../../shared/salesContracts.js';
import { SalesHttpError } from './salesAccess.js';

const SETTINGS_COLUMNS = [
  'tenant_id', 'quote_prefix', 'quote_number_padding', 'default_currency',
  'default_tax_rate_bps', 'default_terms', 'module_enabled', 'version', 'updated_at',
].join(',');

export async function getSalesSettings(db, tenantId) {
  const result = await db.from('sales_settings').select(SETTINGS_COLUMNS)
    .eq('tenant_id', tenantId).maybeSingle();
  if (result.error) throw result.error;
  if (result.data) return mapSalesSettingsRow(result.data);
  return { ...DEFAULT_SALES_SETTINGS, updatedAt: null };
}

export async function patchSalesSettings(db, tenantId, actor, patch) {
  const { data, error } = await db.rpc('patch_sales_settings', {
    p_tenant_id: tenantId,
    p_expected_version: patch.expectedVersion,
    p_patch: {
      ...(patch.quotePrefix !== undefined ? { quotePrefix: patch.quotePrefix } : {}),
      ...(patch.quoteNumberPadding !== undefined ? { quoteNumberPadding: patch.quoteNumberPadding } : {}),
      ...(patch.defaultCurrency !== undefined ? { defaultCurrency: patch.defaultCurrency } : {}),
      ...(patch.defaultTaxRateBps !== undefined ? { defaultTaxRateBps: patch.defaultTaxRateBps } : {}),
      ...(patch.defaultTerms !== undefined ? { defaultTerms: patch.defaultTerms } : {}),
      ...(patch.moduleEnabled !== undefined ? { moduleEnabled: patch.moduleEnabled } : {}),
    },
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
  });
  if (error) {
    if (error.code === '40001') throw new SalesHttpError(409, 'Sales settings were changed; reload and retry');
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('Settings update returned no row');
  return mapSalesSettingsRow(row);
}

export async function allocateSalesNumber(db, tenantId, actor, kind = 'quote') {
  if (!SALES_SEQUENCE_KINDS.includes(kind)) throw new SalesHttpError(400, 'Unsupported Sales sequence kind');
  const { data, error } = await db.rpc('allocate_sales_identifier', {
    p_tenant_id: tenantId,
    p_kind: kind,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.identifier) throw new Error('Identifier allocation returned no value');
  return { kind, identifier: row.identifier, sequenceValue: Number(row.sequence_value) };
}