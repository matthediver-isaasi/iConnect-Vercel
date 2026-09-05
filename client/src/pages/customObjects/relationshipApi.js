export class RelationshipApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const relationshipRequest = async (path, options = {}) => {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new RelationshipApiError(
      response.status,
      body.message || body.error || `Request failed (${response.status})`,
      body.details,
    );
  return body;
};

export const relationshipRoutes = {
  definitions: (objectId, includeArchived = false) => `/api/custom-objects/${objectId}/relationship-definitions${includeArchived ? "?includeArchived=true" : ""}`,
  definitionGraph: (objectId) => `/api/custom-objects/${objectId}/relationship-definition-graph`,
  definitionPage: (objectId, page = 1, pageSize = 100, includeArchived = false) =>
    `/api/custom-objects/${objectId}/relationship-definitions?${new URLSearchParams({
      page,
      pageSize,
      ...(includeArchived ? { includeArchived: "true" } : {}),
    })}`,
  fields: (objectId, page = 1, pageSize = 100, includeInactive = false) =>
    `/api/custom-objects/${objectId}/fields?${new URLSearchParams({
      page,
      pageSize,
      includeInactive: String(includeInactive),
    })}`,
  definition: (objectId, definitionId) =>
    `/api/custom-objects/${objectId}/relationship-definitions/${definitionId}`,
  objects: (page = 1, pageSize = 100) =>
    `/api/custom-objects?${new URLSearchParams({ status: "active", page, pageSize })}`,
  picker: (objectId, params) =>
    `/api/custom-objects/${objectId}/entity-picker?${new URLSearchParams(params)}`,
  initialRelationshipCandidates: (objectId, params) =>
    `/api/custom-objects/${objectId}/initial-relationship-candidates?${new URLSearchParams(params)}`,
  edges: (objectId, params) =>
    `/api/custom-objects/${objectId}/relationships?${new URLSearchParams(params)}`,
  createEdge: (objectId) => `/api/custom-objects/${objectId}/relationships`,
  // The records route selects its transactional create path when relationship
  // data is present; keeping this named route prevents callers treating it as
  // an ordinary record creation.
  createWithRelationships: (objectId) => `/api/custom-objects/${objectId}/records`,
  deleteEdge: (objectId, edgeId) => `/api/custom-objects/${objectId}/relationships/${edgeId}`,
  coreDefinitions: ({ kind, recordId }) =>
    `/api/custom-objects/core/relationship-definitions?${new URLSearchParams({ kind, recordId })}`,
  corePicker: (params) =>
    `/api/custom-objects/core/entity-picker?${new URLSearchParams(params)}`,
  coreEdges: (params) =>
    `/api/custom-objects/core/relationships?${new URLSearchParams(params)}`,
  createCoreEdge: ({ kind, recordId, definitionId, side }) =>
    `/api/custom-objects/core/relationships?${new URLSearchParams({ kind, recordId, definitionId, side })}`,
  deleteCoreEdge: (edgeId, { kind, recordId, definitionId, side }) =>
    `/api/custom-objects/core/relationships/${edgeId}?${new URLSearchParams({ kind, recordId, definitionId, side })}`,
};

export const loadActiveRelationshipObjects = async (
  request = relationshipRequest,
  pageSize = 100,
) => {
  const first = await request(relationshipRoutes.objects(1, pageSize));
  const total = Number(first.total) || 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount > 100)
    throw new Error("There are too many active Custom Objects to load safely.");
  const additional = await Promise.all(
    Array.from(
      { length: Math.max(0, pageCount - 1) },
      (_, index) => request(relationshipRoutes.objects(index + 2, pageSize)),
    ),
  );
  return {
    ...first,
    data: [first, ...additional].flatMap((result) => result.data || []),
  };
};

export const loadRelationshipDefinitions = async (
  objectId,
  request = relationshipRequest,
  pageSize = 100,
  includeArchived = false,
) => {
  const first = await request(
    relationshipRoutes.definitionPage(objectId, 1, pageSize, includeArchived),
  );
  const total = Number(first.total);
  // Older endpoints return an array. It is already a complete response.
  if (!Number.isFinite(total)) return first;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount > 100)
    throw new Error("There are too many relationship definitions to load safely.");
  const additional = await Promise.all(Array.from(
    { length: pageCount - 1 },
    (_, index) => request(
      relationshipRoutes.definitionPage(objectId, index + 2, pageSize, includeArchived),
    ),
  ));
  return { ...first, data: [first, ...additional].flatMap((result) => result.data || []) };
};

export const loadCustomObjectFields = async (
  objectId,
  {
    includeInactive = false,
    request = relationshipRequest,
    pageSize = 100,
  } = {},
) => {
  const first = await request(
    relationshipRoutes.fields(objectId, 1, pageSize, includeInactive),
  );
  const total = Number(first.total);
  if (!Number.isFinite(total)) return first;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount > 100) {
    throw new Error("There are too many Custom Object fields to load safely.");
  }
  const additional = await Promise.all(Array.from(
    { length: pageCount - 1 },
    (_, index) => request(
      relationshipRoutes.fields(objectId, index + 2, pageSize, includeInactive),
    ),
  ));
  return { ...first, data: [first, ...additional].flatMap((result) => result.data || []) };
};