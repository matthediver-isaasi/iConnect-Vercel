import { INVOICING_ADDRESS_KEYS, redactInvoicingAddress } from '../../shared/invoicingAddress.js';

const ENTITIES = new Set(['member', 'organization', 'organizationgroup']);
const normalizeEntity = value => String(value || '').replace(/[-_]/g, '').toLowerCase();
const hasAddress = row => row && typeof row === 'object'
  && INVOICING_ADDRESS_KEYS.some(key => Object.prototype.hasOwnProperty.call(row, key));

// The six core UI fields are virtual: only the dedicated endpoint persists
// them. Reject rather than silently drop mixed profile/address saves.
export function validateInvoicingAddressWrite(entity, payload) {
  if (!ENTITIES.has(normalizeEntity(entity))) return null;
  const containsFields = value => {
    if (Array.isArray(value)) return value.some(containsFields);
    if (!value || typeof value !== 'object') return false;
    return hasAddress(value) || ['rows', 'records', 'items', 'data'].some(key => containsFields(value[key]));
  };
  return containsFields(payload)
    ? { status: 400, error: 'Save private invoicing address fields through /api/invoicing-address after the owner is saved' }
    : null;
}

// Defense in depth for older schemas/joins. No generic route hydrates private
// storage, including admin and own-member responses.
export function projectInvoicingAddressResponse(value) {
  if (Array.isArray(value)) return value.map(projectInvoicingAddressResponse);
  if (!value || typeof value !== 'object') return value;
  const safe = redactInvoicingAddress(value);
  for (const [key, nested] of Object.entries(safe)) {
    if (nested && typeof nested === 'object') safe[key] = projectInvoicingAddressResponse(nested);
  }
  return safe;
}

export async function enforceInvoicingAddressBoundary({ entity, req, res }) {
  const isAddressEntity = ENTITIES.has(normalizeEntity(entity));
  if (!isAddressEntity && !(req.method === 'GET' && req.query?.expand)) return false;
  const queryText = JSON.stringify([req.query?.expand, req.query?.filter, req.query?.sort]).toLowerCase();
  if (INVOICING_ADDRESS_KEYS.some(key => queryText.includes(key))) {
    res.status(400).json({ error: 'Private invoicing addresses are available only through /api/invoicing-address' });
    return true;
  }
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const error = validateInvoicingAddressWrite(entity, req.body);
    if (error) {
      res.status(error.status).json({ error: error.error });
      return true;
    }
  }
  const json = res.json.bind(res);
  res.json = body => json(projectInvoicingAddressResponse(body));
  return false;
}
