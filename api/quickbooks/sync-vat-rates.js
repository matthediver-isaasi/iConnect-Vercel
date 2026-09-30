import { syncQuickBooksTaxRates } from '../_lib/quickbooks.js';
import { getSessionTenantUser, getSessionMember } from '../_lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let appTenantId = null;
  const tenantUser = await getSessionTenantUser(req);
  if (tenantUser) {
    appTenantId = tenantUser.tenant_id;
  } else {
    const sessionMember = await getSessionMember(req);
    if (sessionMember) appTenantId = sessionMember.tenant_id;
  }
  if (!appTenantId) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const syncData = await syncQuickBooksTaxRates(appTenantId);
    return res.status(200).json({
      success: true,
      count: syncData.count,
      rates: syncData.rates,
      syncedAt: syncData.syncedAt,
    });
  } catch (error) {
    console.error('QuickBooks VAT rates sync error:', error);
    const msg = error?.message || '';
    if (/No QuickBooks token|authentication incomplete|credentials not configured/i.test(msg)) {
      return res.status(401).json({
        success: false,
        error: 'QuickBooks authentication failed. Please re-authenticate with QuickBooks in Admin Settings.',
        details: msg,
      });
    }
    return res.status(500).json({
      success: false,
      error: msg || 'Failed to sync VAT rates from QuickBooks',
    });
  }
}
