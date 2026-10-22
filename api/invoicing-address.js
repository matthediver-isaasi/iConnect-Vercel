import { supabase } from './_lib/database.js';
import { getTenantContext, hasAdminAccess } from './_lib/tenantContext.js';
import { INVOICING_ADDRESS_KEYS, invoicingAddressError } from '../shared/invoicingAddress.js';

const OWNER_TYPES = new Set(['member', 'organization', 'organization_group']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pickAddress = row => Object.fromEntries(INVOICING_ADDRESS_KEYS.map(key => [key, row?.[key] ?? null]));
const storageError = (res, error) => {
  const missing = ['42P01', '42883', 'PGRST205', 'PGRST202'].includes(error?.code);
  return res.status(missing ? 503 : 500).json({
    error: missing ? 'Private invoicing address storage is unavailable. Apply the reviewed storage migration before using billing addresses.' : 'Unable to access private invoicing address storage',
    code: missing ? 'INVOICING_ADDRESS_STORAGE_UNAVAILABLE' : 'INVOICING_ADDRESS_STORAGE_ERROR',
  });
};

export default async function handler(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'PATCH'].includes(req.method)) {
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const context = await (dependencies.getTenantContext || getTenantContext)(req);
    if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    const requestedTenant = req.headers?.['x-tenant-id'];
    if (context.tenantMismatch || !context.tenantId || (requestedTenant && requestedTenant !== context.tenantId)) {
      return res.status(403).json({ error: 'Tenant context does not match this session' });
    }
    const params = req.method === 'GET' ? req.query : req.body;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return res.status(400).json({ error: 'Owner details are required' });
    const { ownerType, ownerId } = params;
    if (!OWNER_TYPES.has(ownerType) || typeof ownerId !== 'string' || !UUID.test(ownerId)) {
      return res.status(400).json({ error: 'A valid ownerType and UUID ownerId are required' });
    }
    let patch;
    if (req.method === 'PATCH') {
      if (Object.keys(params).some(key => !['ownerType', 'ownerId', 'address'].includes(key))) {
        return res.status(400).json({ error: 'Unknown invoicing address request field' });
      }
      patch = params.address;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length
        || Object.keys(patch).some(key => !INVOICING_ADDRESS_KEYS.includes(key))) {
        return res.status(400).json({ error: 'Address must contain only changed invoicing address fields' });
      }
      const error = invoicingAddressError(patch);
      if (error) return res.status(400).json({ error });
      patch = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value?.trim() || null]));
    }
    const isOwnMember = ownerType === 'member' && ownerId === context.memberId;
    if (!isOwnMember && !await (dependencies.hasAdminAccess || hasAdminAccess)(context)) {
      return res.status(403).json({ error: 'Not authorized to access this invoicing address' });
    }
    const db = dependencies.db || supabase;
    if (!db) return res.status(503).json({ error: 'Database not configured', code: 'INVOICING_ADDRESS_STORAGE_UNAVAILABLE' });
    const { data: owner, error: ownerError } = await db.from(ownerType)
      .select('id, tenant_id').eq('id', ownerId).eq('tenant_id', context.tenantId).maybeSingle();
    if (ownerError) return storageError(res, ownerError);
    if (!owner || owner.tenant_id !== context.tenantId) return res.status(404).json({ error: 'Address owner not found in this tenant' });
    if (req.method === 'GET') {
      const { data, error } = await db.from('invoicing_address_private')
        .select(INVOICING_ADDRESS_KEYS.join(','))
        .eq('tenant_id', context.tenantId).eq('owner_type', ownerType).eq('owner_id', ownerId).maybeSingle();
      if (error) return storageError(res, error);
      return res.json({ address: pickAddress(data) });
    }
    const { data, error } = await db.rpc('patch_private_invoicing_address', {
      p_tenant_id: context.tenantId, p_owner_type: ownerType, p_owner_id: ownerId, p_address: patch,
    });
    if (error) return storageError(res, error);
    const saved = Array.isArray(data) ? data[0] : data;
    if (!saved) return storageError(res, { code: 'EMPTY_SAVE_RESULT' });
    return res.json({ address: pickAddress(saved) });
  } catch (error) {
    return res.status(503).json({ error: 'Unable to verify invoicing address access or complete the request', code: 'INVOICING_ADDRESS_REQUEST_UNAVAILABLE' });
  }
}
