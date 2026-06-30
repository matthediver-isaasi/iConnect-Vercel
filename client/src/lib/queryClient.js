export function emitTenantContextChanged() {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('tenant-context-changed', {}));
  } catch {
    // no-op
  }
}

export function maybeEmitPlanQuotaFromBody(errorBody) {
  if (errorBody && errorBody.code === 'PLAN_QUOTA_EXCEEDED') {
    emitPlanQuotaExceeded(errorBody.quota, errorBody.error || '');
    return true;
  }
  return false;
}

export function emitPlanQuotaExceeded(quota, errorMessage) {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('plan-quota-exceeded', {
        detail: { quota: quota || null, message: errorMessage || '' },
      }),
    );
  } catch {
    // no-op
  }
}

export async function apiRequest(method, url, data) {
  const options = {
    method,
    credentials: 'include',
    headers: {}
  };

  if (data) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(data);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message = errorData.error || `Request failed with status ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.code = errorData.code;
    err.body = errorData;
    if (errorData.code === 'PLAN_QUOTA_EXCEEDED') {
      err.quota = errorData.quota;
      emitPlanQuotaExceeded(errorData.quota, message);
    }
    if (errorData.code === 'TENANT_CONTEXT_CHANGED') {
      emitTenantContextChanged();
    }
    throw err;
  }

  return response.json();
}
