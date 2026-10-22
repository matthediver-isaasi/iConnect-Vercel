import {
  INVOICING_ADDRESS_KEYS,
  invoicingAddressError,
  redactInvoicingAddress,
} from '../../shared/invoicingAddress.js';

const ENTITIES = new Set(['member', 'organization', 'organizationgroup']);
const normalizeEntity = value => String(value || '').replace(/[-_]/g, '').toLowerCase();
const hasAddress = row => row && typeof row === 'object'
  && INVOICING_ADDRESS_KEYS.some(key => Object.prototype.hasOwnProperty.call(row, key));

export function validateInvoicingAddressWrite(entity, payload, context, { isAdmin = false, id = null } = {}) {
  const normalized = normalizeEntity(entity);
  if (!ENTITIES.has(normalized)) return null;
  for (const row of Array.isArray(payload) ? payload : [payload]) {
    if (!hasAddress(row)) continue;
    // Membership of an organisation/group conveys NO billing-edit authority.
    const ownsMember = normalized === 'member' && id && id === context?.memberId;
    if (!context?.isAuthenticated || context?.tenantMismatch || (!isAdmin && !ownsMember)) {
      return { status: 403, error: 'Not authorized to edit this invoicing address' };
    }
    const error = invoicingAddressError(row);
    if (error) return { status: 400, error };
  }
  return null;
}

// Project every response shape (single row, list, counted list, write response),
// including joined organisations/groups. Only the member's own root record is
// visible to a non-admin; a related entity never inherits that exception.
export function projectInvoicingAddressResponse(value, entity, context, isAdmin = false) {
  if (isAdmin) return value;
  const visit = (input, rootRows) => {
    if (Array.isArray(input)) return input.map(item => visit(item, rootRows));
    if (!input || typeof input !== 'object') return input;
    const isRootRecord = rootRows && Object.prototype.hasOwnProperty.call(input, 'id');
    const ownsMember = isRootRecord && normalizeEntity(entity) === 'member'
      && context?.isAuthenticated && !context.tenantMismatch && context.memberId && input.id === context.memberId;
    const safe = ownsMember ? { ...input } : redactInvoicingAddress(input);
    for (const [key, nested] of Object.entries(safe)) {
      if (nested && typeof nested === 'object') {
        // Only the counted-list envelope's data contains root records.
        // A join aliased "data" on a member record remains a private join.
        safe[key] = visit(nested, rootRows && !isRootRecord && key === 'data');
      }
    }
    return safe;
  };
  return visit(value, true);
}

export async function enforceInvoicingAddressBoundary({ entity, id = null, req, res, context, hasAdminAccess }) {
  const isAddressEntity = ENTITIES.has(normalizeEntity(entity));
  // Other generic entities can join member/organization rows through expand.
  // Their wildcard joins need the same recursive privacy projection.
  if (!isAddressEntity && !(req.method === 'GET' && req.query?.expand)) return false;
  const isAdmin = !context?.tenantMismatch && !!context?.isAuthenticated && await hasAdminAccess(context);
  const queryText = JSON.stringify([req.query?.expand, req.query?.filter, req.query?.sort]).toLowerCase();
  if (!isAdmin && INVOICING_ADDRESS_KEYS.some(key => queryText.includes(key))) {
    res.status(403).json({ error: 'Private invoicing address fields cannot be queried through generic projections or filters' });
    return true;
  }
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const error = validateInvoicingAddressWrite(entity, req.body, context, { isAdmin, id });
    if (error) {
      res.status(error.status).json({ error: error.error });
      return true;
    }
  }
  const json = res.json.bind(res);
  res.json = body => json(projectInvoicingAddressResponse(body, entity, context, isAdmin));
  return false;
}
