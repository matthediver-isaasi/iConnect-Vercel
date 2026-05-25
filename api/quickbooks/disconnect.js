import { getSessionTenantUser } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
import {
  disconnectActiveAccountingProvider,
  getActiveAccountingProvider,
  PROVIDER_QUICKBOOKS,
} from '../_lib/accountingProvider.js';
import { revokeQuickBooksToken, getQuickBooksTokenRow } from '../_lib/quickbooks.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) return res.status(401).json({ error: 'Unauthorized' });

  const removeCredentials = !!(req.body && req.body.removeCredentials);

  try {
    const tokenRow = await getQuickBooksTokenRow(tenantUser.tenant_id);
    if (tokenRow?.refresh_token) {
      await revokeQuickBooksToken(tenantUser.tenant_id, tokenRow.refresh_token);
    }

    const { error } = await supabase
      .from('quickbooks_token')
      .delete()
      .eq('app_tenant_id', tenantUser.tenant_id);

    if (error) {
      console.error('[QBO] Disconnect error:', error);
      return res.status(500).json({ error: 'Failed to disconnect QuickBooks' });
    }

    try {
      const active = await getActiveAccountingProvider(tenantUser.tenant_id);
      if (active === PROVIDER_QUICKBOOKS) {
        await disconnectActiveAccountingProvider(tenantUser.tenant_id);
      } else {
        console.log('[QBO] Active provider is', active, '— leaving active provider setting untouched.');
      }
    } catch (provErr) {
      console.error('[QBO] Failed to clear active accounting provider (non-fatal):', provErr.message);
    }

    if (removeCredentials) {
      try {
        await supabase
          .from('tenant_integrations')
          .delete()
          .eq('tenant_id', tenantUser.tenant_id)
          .eq('integration_type', 'quickbooks');
      } catch (credErr) {
        console.error('[QBO] Failed to delete credentials (non-fatal):', credErr.message);
      }
    }

    console.log('[QBO] Disconnected for tenant:', tenantUser.tenant_id);
    res.json({ success: true });
  } catch (error) {
    console.error('[QBO] Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect QuickBooks' });
  }
}
