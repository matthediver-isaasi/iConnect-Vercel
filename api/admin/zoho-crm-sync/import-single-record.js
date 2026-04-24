import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { importSingleZohoRecord } from '../../_lib/zohoCrmSync.js';

const ALLOWED_ENTITY_TYPES = new Set(['organization', 'member']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });
    const tenantId = ctx.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'Tenant context missing' });

    const { entityType, zohoRecordId, dryRun } = req.body || {};
    if (!ALLOWED_ENTITY_TYPES.has(entityType)) {
      return res.status(400).json({ error: 'entityType must be "organization" or "member"' });
    }
    const trimmedId = typeof zohoRecordId === 'string' ? zohoRecordId.trim() : '';
    if (!trimmedId) {
      return res.status(400).json({ error: 'zohoRecordId is required' });
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmedId)) {
      return res.status(400).json({ error: 'zohoRecordId is not a valid Zoho record id' });
    }

    const result = await importSingleZohoRecord(tenantId, entityType, trimmedId, {
      dryRun: dryRun === true
    });
    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.error('[ZohoCrmSync import-single-record] Error:', err);
    return res.status(400).json({ error: err.message || String(err) });
  }
}
