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
  definition: (objectId, definitionId) =>
    `/api/custom-objects/${objectId}/relationship-definitions/${definitionId}`,
  objects: (page = 1, pageSize = 100) =>
    `/api/custom-objects?${new URLSearchParams({ status: "active", page, pageSize })}`,
  picker: (objectId, params) =>
    `/api/custom-objects/${objectId}/entity-picker?${new URLSearchParams(params)}`,
  edges: (objectId, params) =>
    `/api/custom-objects/${objectId}/relationships?${new URLSearchParams(params)}`,
  createEdge: (objectId) => `/api/custom-objects/${objectId}/relationships`,
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