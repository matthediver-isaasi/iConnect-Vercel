import { getValidQuickBooksAccessToken } from '../_lib/quickbooks.js';
import { getIntuitEndpoints } from '../_lib/quickbooksCredentials.js';
import { getSessionTenantUser, getSessionMember } from '../_lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let appTenantId = null;
  const tu = await getSessionTenantUser(req);
  if (tu) appTenantId = tu.tenant_id;
  else {
    const m = await getSessionMember(req);
    if (m) appTenantId = m.tenant_id;
  }
  if (!appTenantId) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const { accessToken, realmId, environment } = await getValidQuickBooksAccessToken(appTenantId);
    const { apiBaseUrl } = getIntuitEndpoints(environment);
    const query = "SELECT Id, Name, AccountType, AccountSubType, Active FROM Account WHERE Active = true AND (AccountType = 'Bank' OR AccountType = 'Other Current Asset') MAXRESULTS 500";
    const url = `${apiBaseUrl}/v3/company/${encodeURIComponent(realmId)}/query?minorversion=70&query=${encodeURIComponent(query)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(502).json({ error: `QBO Account query failed: HTTP ${resp.status} ${text.slice(0, 300)}` });
    }
    const data = await resp.json();
    const accounts = (data?.QueryResponse?.Account || []).map((a) => ({
      id: a.Id,
      name: a.Name,
      type: a.AccountType,
      subType: a.AccountSubType,
    }));
    return res.status(200).json({ accounts });
  } catch (err) {
    const msg = err?.message || 'Failed to fetch QuickBooks accounts';
    if (/No QuickBooks token|authentication incomplete|credentials not configured/i.test(msg)) {
      return res.status(401).json({ error: 'QuickBooks authentication required.', details: msg });
    }
    return res.status(500).json({ error: msg });
  }
}
