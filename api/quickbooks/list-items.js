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
    const query = "SELECT Id, Name, Type, Active FROM Item WHERE Active = true MAXRESULTS 1000";
    const url = `${apiBaseUrl}/v3/company/${encodeURIComponent(realmId)}/query?minorversion=70&query=${encodeURIComponent(query)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(502).json({ error: `QBO Item query failed: HTTP ${resp.status} ${text.slice(0, 300)}` });
    }
    const data = await resp.json();
    const items = (data?.QueryResponse?.Item || []).map((it) => ({
      id: it.Id,
      name: it.Name,
      type: it.Type,
    }));
    return res.status(200).json({ items });
  } catch (err) {
    const msg = err?.message || 'Failed to fetch QuickBooks items';
    if (/No QuickBooks token|authentication incomplete|credentials not configured/i.test(msg)) {
      return res.status(401).json({ error: 'QuickBooks authentication required.', details: msg });
    }
    return res.status(500).json({ error: msg });
  }
}
