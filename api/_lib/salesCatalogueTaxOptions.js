import { getActiveAccountingProvider } from './accountingProvider.js';
import { SalesHttpError } from './salesAccess.js';

// Read the existing synced snapshot only. Opening a product must not consume
// provider API quota or change the administrator's accounting mappings.
export async function listCatalogueTaxOptions(db, tenantId, dependencies = {}) {
  const provider = await (dependencies.getActiveAccountingProvider || getActiveAccountingProvider)(tenantId);
  if (!['xero', 'quickbooks'].includes(provider)) {
    throw new SalesHttpError(409, 'Connect an accounting provider and sync its VAT/tax codes first.');
  }
  const { data: saved, error: snapshotError } = await db.from('system_settings')
    .select('setting_value').eq('tenant_id', tenantId).eq('setting_key', 'xero_vat_rates').maybeSingle();
  if (snapshotError) throw snapshotError;
  let snapshot;
  try {
    snapshot = typeof saved?.setting_value === 'string' ? JSON.parse(saved.setting_value) : saved?.setting_value;
  } catch {
    throw new SalesHttpError(409, 'The saved VAT/tax codes are invalid. Sync them again in accounting settings.');
  }
  // Both providers publish this tenant-scoped compatibility key. Historical
  // Xero snapshots omit provider; QuickBooks snapshots always identify it.
  if (!snapshot || !Array.isArray(snapshot.rates) || (snapshot.provider || 'xero') !== provider) {
    throw new SalesHttpError(409, 'Sync VAT/tax codes for the active accounting provider first.');
  }
  const items = snapshot.rates.flatMap(rate => {
    if (rate.status !== 'ACTIVE' || rate.canApplyToRevenue !== true
      || !['number', 'string'].includes(typeof rate.effectiveRate) || String(rate.effectiveRate).trim() === ''
      || !rate.taxType || !rate.name) return [];
    const percent = Number(rate.effectiveRate);
    const rateBps = Math.round(percent * 100);
    if (!Number.isFinite(percent) || percent < 0 || rateBps > 100000
      || Math.abs(percent * 100 - rateBps) > 0.000001) return [];
    const id = String(rate.taxType);
    return [{
      id, name: String(rate.name), rateBps, selectable: true, reason: null,
    }];
  }).sort((a, b) => a.rateBps - b.rateBps || a.name.localeCompare(b.name));
  return {
    provider, syncedAt: snapshot.syncedAt || null, items,
    note: 'Choose a synced sales tax code. Its rate is applied automatically and its accounting identity is preserved on quotes and invoices.',
  };
}

export async function resolveSalesTaxCode(db, tenantId, choice, dependencies = {}) {
  if (!choice || typeof choice.id !== 'string' || !['xero', 'quickbooks'].includes(choice.provider)) {
    throw new SalesHttpError(400, 'Select an accounting VAT/tax code.');
  }
  const options = await listCatalogueTaxOptions(db, tenantId, dependencies);
  const code = options.items.find(item => item.id === choice.id);
  if (choice.provider !== options.provider || !code) {
    throw new SalesHttpError(409, 'The selected tax code is not available for the active accounting provider. Refresh the synced codes.');
  }
  return { provider: options.provider, id: code.id, name: code.name, rateBps: code.rateBps };
}
