// Request-local authority, never accepted from body/query or persisted by clients.
const personalPaymentOwner = Symbol('formPersonalPaymentOwner');

export function bindFormPersonalPaymentOwner(req, { tenantId, memberId, organizationId }) {
  if (organizationId || !tenantId || !memberId) return;
  const context = req.membershipPaymentContext;
  if (!['form-joining', 'form-renewal'].includes(context?.source)
    || context.simulation?.config?.structure_scope_type !== 'member') return;
  req[personalPaymentOwner] = { tenantId, memberId };
}

export function hasFormPersonalPaymentOwner(req, member) {
  const owner = req?.[personalPaymentOwner];
  return Boolean(req?.method === 'POST' && req.body?.action === 'start'
    && owner && owner.tenantId === member?.tenant_id && owner.memberId === member?.id);
}
