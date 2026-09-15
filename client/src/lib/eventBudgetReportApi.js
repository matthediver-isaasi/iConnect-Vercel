const DEFAULT_OPERATION = "load the Event Budget Report";

/**
 * Keep report failures actionable instead of exposing an opaque fetch error.
 * The report and cost-line endpoints share the same authentication and tenant
 * context, so these status-specific messages deliberately remain consistent
 * for queries and mutations.
 */
export function eventBudgetErrorMessage(error, operation = DEFAULT_OPERATION) {
  const status = typeof error === "number" ? error : error?.status;
  const code = typeof error === "object" ? error?.code || error?.body?.code : undefined;
  const serverMessage = typeof error === "object"
    ? error?.body?.error || error?.error
    : undefined;

  if (status === 401) {
    return `${serverMessage ? `${serverMessage}. ` : ""}Your session has expired. Please sign in again to continue.`;
  }
  if (status === 403) {
    return `${serverMessage ? `${serverMessage}. ` : ""}You do not have permission to ${operation}. Contact an administrator if you need access.`;
  }
  if (status === 409 || code === "TENANT_CONTEXT_CHANGED") {
    return `${serverMessage ? `${serverMessage}. ` : ""}This tab is out of date because the organisation changed. Please reload the page before trying again.`;
  }
  if (!status || status >= 500 || status === 503) {
    return `${serverMessage ? `${serverMessage}. ` : ""}The Event Budget Report service is temporarily unavailable. Please retry ${operation} in a moment.`;
  }

  return serverMessage || error?.message || `Unable to ${operation}.`;
}

export function createEventBudgetError(status, body, operation = DEFAULT_OPERATION) {
  const error = new Error(eventBudgetErrorMessage({ status, body }, operation));
  error.status = status;
  error.code = body?.code;
  error.body = body || {};
  return error;
}

/**
 * Parse a report response while preserving the endpoint's status/code for
 * callers that need to distinguish auth, permission, tenant, and service
 * failures.
 */
export async function readEventBudgetResponse(response, operation = DEFAULT_OPERATION) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createEventBudgetError(response.status, body, operation);
  }
  return body;
}

/**
 * Normalise network errors (which have no HTTP status) and errors thrown by
 * callers before a response is available into the same actionable shape.
 */
export function normalizeEventBudgetError(error, operation = DEFAULT_OPERATION) {
  if (error?.status || error?.code === "TENANT_CONTEXT_CHANGED") {
    const normalized = new Error(eventBudgetErrorMessage(error, operation));
    normalized.status = error.status;
    normalized.code = error.code;
    normalized.body = error.body;
    return normalized;
  }

  const normalized = new Error(eventBudgetErrorMessage(null, operation));
  normalized.cause = error;
  return normalized;
}