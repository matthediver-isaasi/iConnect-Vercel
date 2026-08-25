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
  objects: () => "/api/custom-objects?status=active",
  picker: (objectId, params) =>
    `/api/custom-objects/${objectId}/entity-picker?${new URLSearchParams(params)}`,
  edges: (objectId, params) =>
    `/api/custom-objects/${objectId}/relationships?${new URLSearchParams(params)}`,
  createEdge: (objectId) => `/api/custom-objects/${objectId}/relationships`,
  deleteEdge: (objectId, edgeId) => `/api/custom-objects/${objectId}/relationships/${edgeId}`,
};