import { getSessionTenantUser } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
import { getValidQuickBooksAccessToken, fetchCompanyInfo } from '../_lib/quickbooks.js';

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

  try {
    const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(
      tenantUser.tenant_id
    );
    const companyInfo = await fetchCompanyInfo(accessToken, realmId, environment);

    if (!companyInfo) {
      return res.status(502).json({
        success: false,
        error: 'QuickBooks responded but returned no CompanyInfo',
      });
    }

    return res.status(200).json({
      success: true,
      realmId,
      environment,
      company: {
        name: companyInfo.CompanyName || companyInfo.LegalName || null,
        legalName: companyInfo.LegalName || null,
        country: companyInfo.Country || null,
        email: companyInfo.Email?.Address || null,
        fiscalYearStartMonth: companyInfo.FiscalYearStartMonth || null,
        supportedLanguages: companyInfo.SupportedLanguages || null,
      },
    });
  } catch (error) {
    console.error('[Admin] QuickBooks test-connection error:', error);
    const msg = error?.message || 'QuickBooks connection test failed';
    const status = /No QuickBooks token|authentication incomplete|credentials not configured|refresh/i.test(msg)
      ? 401
      : 502;
    return res.status(status).json({ success: false, error: msg });
  }
}
