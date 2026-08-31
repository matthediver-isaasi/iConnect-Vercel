export class OpportunityHttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function principalFromContext(context) {
  if (context?.tenantUserId) return { kind: 'tenant_user', id: context.tenantUserId };
  if (context?.memberId) return { kind: 'member', id: context.memberId };
  throw new OpportunityHttpError(401, 'Authenticated opportunity principal required');
}

export function samePrincipal(left, right) {
  return Boolean(left?.kind && left?.id && left.kind === right?.kind && left.id === right?.id);
}

export function opportunityPermissions(opportunity, principal, collaborators = [], isAdmin = false) {
  const owner = samePrincipal(
    { kind: opportunity?.owner_kind, id: opportunity?.owner_id },
    principal,
  );
  const collaborator = collaborators.some((item) => samePrincipal(
    { kind: item.principal_kind, id: item.principal_id },
    principal,
  ));
  return {
    canView: isAdmin || owner || collaborator,
    canEdit: isAdmin || owner || collaborator,
    canManage: isAdmin || owner,
  };
}

export function validateStageChange(stage, lossReasonId) {
  if (!stage || stage.is_active === false) {
    throw new OpportunityHttpError(400, 'An active destination stage is required');
  }
  if (stage.is_lost && !lossReasonId) {
    throw new OpportunityHttpError(400, 'A loss reason is required for a lost opportunity');
  }
  if (!stage.is_lost && lossReasonId) {
    throw new OpportunityHttpError(400, 'A loss reason is only valid for a lost opportunity');
  }
  return { lossReasonId: stage.is_lost ? lossReasonId : null };
}

export function assertExpectedVersion(opportunity, expectedVersion) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new OpportunityHttpError(400, 'expectedVersion must be a positive integer');
  }
  if (opportunity.version !== expectedVersion) {
    throw new OpportunityHttpError(409, 'Opportunity was updated by another user', 'STALE_UPDATE');
  }
}

export function parsePagination(query = {}, maximum = 100) {
  const page = Number(query.page || 1);
  const pageSize = Number(query.pageSize || query.limit || 25);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize)
      || pageSize < 1 || pageSize > maximum) {
    throw new OpportunityHttpError(400, `page and pageSize (maximum ${maximum}) are invalid`);
  }
  return { page, pageSize, from: (page - 1) * pageSize, to: page * pageSize - 1 };
}

export function validatePriority(value) {
  if (!['low', 'medium', 'high', 'urgent'].includes(value)) {
    throw new OpportunityHttpError(400, 'priority must be low, medium, high, or urgent');
  }
  return value;
}

export function assertPrivateDocumentPath(tenantId, opportunityId, bucket, storagePath) {
  const prefix = `${tenantId}/opportunities/${opportunityId}/`;
  if (bucket !== 'private-uploads' || typeof storagePath !== 'string'
      || !storagePath.startsWith(prefix) || storagePath.includes('..')) {
    throw new OpportunityHttpError(400, 'Document must use the opportunity private storage path');
  }
}